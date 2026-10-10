# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""Expand real launch descriptions while intercepting every process execution."""

import os
from pathlib import Path
import xml.etree.ElementTree as ET

import ament_index_python.packages
from launch import LaunchContext
from launch.actions import ExecuteProcess
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch.utilities import visit_all_entities_and_collect_futures
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.actions.load_composable_nodes import get_composable_node_load_request
from launch_ros.substitutions import FindPackageShare
import pytest
import questix_control_config
from rclpy.parameter import Parameter
import yaml


@pytest.fixture
def source_packages(monkeypatch, tmp_path):
    """Resolve every package share to its source directory, with no saved operator profile."""
    # The source root comes from QUESTIX_SOURCE_ROOT, set by CMakeLists.txt for the tests that
    # use these fixtures; it is returned for them.
    root = Path(os.environ['QUESTIX_SOURCE_ROOT'])
    packages = {ET.parse(path).getroot().findtext('name'): str(path.parent)
                for path in root.glob('*/package.xml')}
    monkeypatch.setenv('QUESTIX_CONFIG_DIR', str(tmp_path))
    monkeypatch.setattr(FindPackageShare, 'find', lambda self, name: packages[name])
    monkeypatch.setattr(ament_index_python.packages, 'get_package_share_directory',
                        lambda name: packages[name])
    monkeypatch.setattr(questix_control_config, 'get_package_share_directory',
                        lambda name: packages[name])
    return root


@pytest.fixture
def expand(monkeypatch, source_packages):
    """Return effective per-node parameters, never opening hardware or running a node."""
    def forbid_process(*args, **kwargs):
        raise AssertionError('Hardware/process execution is forbidden in this test')

    monkeypatch.setattr(ExecuteProcess, 'execute', forbid_process)

    def run(relative_path, **arguments):
        nodes = {}

        def capture(node, context):
            node._perform_substitutions(context)
            parameters = {}
            for filename, is_file in node._Node__expanded_parameter_arguments or []:
                assert is_file
                document = yaml.safe_load(Path(filename).read_text())
                for selector in ('/**', node.node_name.lstrip('/'), node.node_name):
                    parameters.update(document.get(selector, {}).get('ros__parameters', {}))
            assert node.node_name not in nodes
            nodes['/' + node.node_name.lstrip('/')] = parameters
            return []

        def capture_container(container, context):
            for description in container._ComposableNodeContainer__composable_node_descriptions:
                request = get_composable_node_load_request(description, context)
                nodes['/' + request.node_name] = {
                    parameter.name: Parameter.from_parameter_msg(parameter).value
                    for parameter in request.parameters}
            return []

        monkeypatch.setattr(ComposableNodeContainer, 'execute', capture_container)
        monkeypatch.setattr(Node, 'execute', capture)
        context = LaunchContext()
        context.launch_configurations['ros_namespace'] = '/'
        context.launch_configurations.update(arguments)
        description = AnyLaunchDescriptionSource(str(source_packages / relative_path))
        visit_all_entities_and_collect_futures(
            description.get_launch_description(context), context)
        return nodes

    return run
