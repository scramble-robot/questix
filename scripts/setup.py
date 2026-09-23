from pathlib import Path

from setuptools import setup, find_packages

# Pinned dependencies live in one place, shared with the install/update scripts and Ansible.
REQUIREMENTS = Path(__file__).parent / "robot_manager" / "requirements.txt"


def read_requirements():
    lines = (line.split("#", 1)[0].strip() for line in REQUIREMENTS.read_text().splitlines())
    return [line for line in lines if line]


setup(
    name="robot-manager",
    version="3.2.0",
    packages=find_packages(),
    include_package_data=True,
    package_data={"robot_manager": ["static/*", "static/**/*", "requirements.txt"]},
    install_requires=read_requirements(),
)
