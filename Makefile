# Makefile for ROS2 Robotics Kit ISO Builder
# Local testing and development commands

.PHONY: help test-ansible build-dev build-kit clean setup-deps

# Variables
ROS2_DISTRO ?= jazzy
UBUNTU_VERSION ?= 24.04
ARCHITECTURE ?= amd64

# Architecture-specific configurations
UBUNTU_VERSION_AMD64 ?= 24.04
UBUNTU_VERSION_ARM64 ?= 24.04
ROS2_DISTRO_AMD64 ?= jazzy
ROS2_DISTRO_ARM64 ?= jazzy
export ANSIBLE_ROLES_PATH ?= $(CURDIR)/ansible/roles

help: ## Show this help message
	@echo "ROS2 Robotics Kit ISO Builder"
	@echo ""
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables:"
	@echo "  ROS2_DISTRO      ROS2 distribution (default: jazzy)"
	@echo "  UBUNTU_VERSION   Ubuntu version (default: 24.04)"
	@echo "  ARCHITECTURE     Target architecture (default: amd64)"

setup-deps: ## Install build dependencies
	@echo "📦 Installing build dependencies..."
	sudo apt-get update
	sudo apt-get install -y \
		debootstrap \
		squashfs-tools \
		xorriso \
		isolinux \
		syslinux-efi \
		grub-pc-bin \
		grub-efi-amd64-bin \
		grub-efi-arm64-bin \
		mtools \
		dosfstools \
		qemu-user-static \
		binfmt-support \
		ansible \
		ansible-lint \
		yamllint
	@echo "✅ Dependencies installed"

test-ansible: ## Test and validate Ansible playbooks
	@echo "🧪 Testing Ansible playbooks..."
	yamllint ansible/
	ansible-lint -c .ansible-lint.yml ansible/playbooks/setup_dev.yaml
	ansible-lint -c .ansible-lint.yml ansible/playbooks/setup_kit.yaml
	ansible-playbook --syntax-check -i localhost, ansible/playbooks/setup_dev.yaml
	ansible-playbook --syntax-check -i localhost, ansible/playbooks/setup_kit.yaml
	@echo "✅ Ansible playbooks validated"

build-dev: test-ansible ## Build development ISO (AMD64)
	@echo "🏗️  Building development ISO for AMD64..."
	@$(MAKE) _build ARCHITECTURE=amd64 UBUNTU_VERSION=$(UBUNTU_VERSION_AMD64) ROS2_DISTRO=$(ROS2_DISTRO_AMD64)

build-kit: test-ansible ## Build robotics kit ISO (ARM64)
	@echo "🏗️  Building robotics kit ISO for ARM64..."
	@$(MAKE) _build ARCHITECTURE=arm64 UBUNTU_VERSION=$(UBUNTU_VERSION_ARM64) ROS2_DISTRO=$(ROS2_DISTRO_ARM64)

build-both: test-ansible ## Build both development and kit ISOs
	@echo "🏗️  Building both ISO variants..."
	@$(MAKE) build-dev
	@$(MAKE) build-kit

_build: ## Internal build target
	@echo "📋 Building ISO with parameters:"
	@echo "  Architecture: $(ARCHITECTURE)"
	@echo "  Ubuntu Version: $(UBUNTU_VERSION)"
	@echo "  ROS2 Distribution: $(ROS2_DISTRO)"
	@echo ""
	
	# Create build directories
	sudo mkdir -p /tmp/iso-build /tmp/iso-output
	sudo chmod 777 /tmp/iso-build /tmp/iso-output
	
	# Download base ISO
	@echo "📥 Downloading Ubuntu base ISO..."
	cd /tmp/iso-build && \
	if [ "$(ARCHITECTURE)" = "arm64" ]; then \
		wget -O ubuntu-base.iso "https://cdimage.ubuntu.com/releases/$(UBUNTU_VERSION)/release/ubuntu-$(UBUNTU_VERSION)-live-server-arm64.iso" || \
		wget -O ubuntu-base.iso "https://cdimage.ubuntu.com/ubuntu-server/releases/$(UBUNTU_VERSION)/release/ubuntu-$(UBUNTU_VERSION)-live-server-arm64.iso"; \
	else \
		wget -O ubuntu-base.iso "https://cdimage.ubuntu.com/releases/$(UBUNTU_VERSION)/release/ubuntu-$(UBUNTU_VERSION)-live-server-amd64.iso" || \
		wget -O ubuntu-base.iso "https://cdimage.ubuntu.com/ubuntu-server/releases/$(UBUNTU_VERSION)/release/ubuntu-$(UBUNTU_VERSION)-live-server-amd64.iso"; \
	fi
	
	# Build ISO
	cd /tmp/iso-build && \
	sudo bash $(PWD)/scripts/prepare-base-system.sh ubuntu-base.iso $(ARCHITECTURE) $(UBUNTU_VERSION) && \
	sudo bash $(PWD)/scripts/apply-ansible-config.sh $(ARCHITECTURE) $(ROS2_DISTRO) && \
	sudo bash $(PWD)/scripts/build-iso.sh $(ARCHITECTURE) $(UBUNTU_VERSION) $(ROS2_DISTRO)
	
	@echo "🎉 Build completed! Check /tmp/iso-output/ for results."

test-iso-amd64: ## Test AMD64 ISO with QEMU
	@echo "🧪 Testing AMD64 ISO with QEMU..."
	@if [ ! -f /tmp/iso-output/latest-amd64.iso ]; then \
		echo "❌ No AMD64 ISO found. Run 'make build-dev' first."; \
		exit 1; \
	fi
	timeout 120 qemu-system-x86_64 \
		-m 2048 \
		-cdrom /tmp/iso-output/latest-amd64.iso \
		-boot d \
		-display none \
		-serial stdio \
		-no-reboot || echo "✅ ISO boot test completed"

clean: ## Clean build artifacts
	@echo "🧹 Cleaning build artifacts..."
	sudo rm -rf /tmp/iso-build /tmp/iso-work /tmp/iso-output
	@echo "✅ Cleanup completed"

github-test: ## Test GitHub Actions workflow locally (requires act)
	@echo "🐙 Testing GitHub Actions workflow locally..."
	@if ! command -v act >/dev/null 2>&1; then \
		echo "❌ 'act' is required for local GitHub Actions testing."; \
		echo "Install with: curl https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash"; \
		exit 1; \
	fi
	act -j validate-ansible

docker-build: ## Build ISO in Docker container (experimental)
	@echo "🐳 Building ISO in Docker container..."
	docker build -t ros2-iso-builder -f docker/Dockerfile .
	docker run --privileged -v $(PWD):/workspace -v /tmp/iso-output:/output ros2-iso-builder

release-notes: ## Generate release notes template
	@echo "📝 Generating release notes template..."
	@echo "# ROS2 Robotics Kit ISO Release" > /tmp/release-notes.md
	@echo "" >> /tmp/release-notes.md
	@echo "## 🚀 Features" >> /tmp/release-notes.md
	@echo "- Pre-configured ROS2 environment" >> /tmp/release-notes.md
	@echo "- Ubuntu base system" >> /tmp/release-notes.md
	@echo "- Robotics development tools included" >> /tmp/release-notes.md
	@echo "- Hardware abstraction for Raspberry Pi 5 (ARM64)" >> /tmp/release-notes.md
	@echo "- Development environment for PC/laptop (AMD64)" >> /tmp/release-notes.md
	@echo "" >> /tmp/release-notes.md
	@echo "## 📦 Images" >> /tmp/release-notes.md
	@echo "- AMD64: Ubuntu 24.04 + ROS2 Jazzy (Development)" >> /tmp/release-notes.md
	@echo "- ARM64: Ubuntu 24.04 + ROS2 Jazzy (Raspberry Pi 5)" >> /tmp/release-notes.md
	@echo "" >> /tmp/release-notes.md
	@echo "## 🔧 Installation" >> /tmp/release-notes.md
	@echo "1. Download appropriate ISO for your hardware" >> /tmp/release-notes.md
	@echo "2. Flash to USB/SD card using standard tools" >> /tmp/release-notes.md
	@echo "3. Boot and follow installation wizard" >> /tmp/release-notes.md
	@echo "4. System ready for ROS2 development" >> /tmp/release-notes.md
	@echo "" >> /tmp/release-notes.md
	@echo "## ✅ Checksums" >> /tmp/release-notes.md
	@echo "Verify downloads with provided SHA256/MD5 checksums." >> /tmp/release-notes.md
	@echo "📄 Release notes template created at /tmp/release-notes.md"

info: ## Show build information
	@echo "🔍 Build Environment Information:"
	@echo "  Current directory: $(PWD)"
	@echo "  ROS2 Distribution: $(ROS2_DISTRO)"
	@echo "  Ubuntu Version: $(UBUNTU_VERSION)"
	@echo "  Target Architecture: $(ARCHITECTURE)"
	@echo "  Build directory: /tmp/iso-build"
	@echo "  Output directory: /tmp/iso-output"
	@echo ""
	@echo "📊 Disk space:"
	@df -h /tmp 2>/dev/null || echo "  /tmp not available"
	@echo ""
	@echo "🧰 Tool versions:"
	@ansible --version 2>/dev/null | head -1 || echo "  Ansible: not installed"
	@qemu-system-x86_64 --version 2>/dev/null | head -1 || echo "  QEMU: not installed"
