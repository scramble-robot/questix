from glob import glob

from setuptools import setup

package_name = "web_joy_driver"

setup(
    name=package_name,
    version="3.2.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", glob("launch/*.launch.xml")),
        ("share/" + package_name + "/config", glob("config/*.yaml")),
        ("share/" + package_name + "/static", glob("static/*")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="asa-naki",
    maintainer_email="aki.grade2580@outlook.jp",
    description="Browser virtual controller that publishes sensor_msgs/Joy over WebSocket.",
    license="MIT",
    tests_require=["pytest"],
    entry_points={
        "console_scripts": [
            "web_joy_driver_node = web_joy_driver.web_joy_driver_node:main",
        ],
    },
)
