from setuptools import setup, find_packages

setup(
    name="robot-manager",
    version="3.2.0",
    packages=find_packages(),
    include_package_data=True,
    package_data={"robot_manager": ["static/*"]},
    install_requires=[
        "fastapi",
        "PyYAML>=6.0",
        "uvicorn[standard]",
    ],
)
