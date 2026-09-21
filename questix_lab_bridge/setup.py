from glob import glob

from setuptools import find_packages, setup

package_name = 'questix_lab_bridge'

setup(
    name=package_name,
    version='3.2.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', glob('launch/*.launch.xml')),
        ('share/' + package_name + '/config', glob('config/*.yaml')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='asa-naki',
    maintainer_email='aki.grade2580@outlook.jp',
    description='Read-only WebSocket bridge for the QUESTiX LAB web teaching material.',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'lab_bridge_node = questix_lab_bridge.bridge_node:main',
        ],
    },
)
