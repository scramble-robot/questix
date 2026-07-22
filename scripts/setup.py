from setuptools import setup, find_packages

setup(
    name="robot-manager",
    version="2.0.1",
    packages=find_packages(),
    include_package_data=True,
    package_data={"robot_manager": ["static/*"]},
    install_requires=[
        "fastapi",
        "uvicorn[standard]",
    ],
)
