from glob import glob

from setuptools import setup

package_name = "udp_joy_driver"

setup(
    name=package_name,
    version="3.2.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml", "README.md"]),
        ("share/" + package_name + "/launch", glob("launch/*.launch.py")),
        ("share/" + package_name + "/config", glob("config/*.yaml")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="asa-naki",
    maintainer_email="aki.grade2580@outlook.jp",
    description="CoRE UDP controller input for QUESTiX.",
    license="MIT",
    tests_require=["pytest"],
    entry_points={
        "console_scripts": [
            "udp_joy_driver_node = udp_joy_driver.udp_joy_driver_node:main",
        ],
    },
)
