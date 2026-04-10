from setuptools import setup, find_packages

setup(
    name="robot-manager",
    version="0.1.0",
    packages=find_packages(),
    include_package_data=True,
    package_data={"robot_manager": ["static/*"]},
    install_requires=[
        "fastapi",
        "uvicorn[standard]",
    ],
)
