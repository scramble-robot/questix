"""One-shot ROS GetParameters worker; imported only inside the ROS environment."""

import json
import os
import sys
import time


def collect(node, requested, spin_once, decode, service_type, timeout=2.5):
    """Discover and query all nodes against one shared deadline without retries forever."""
    reports = {name: {'status': 'unavailable', 'values': {}} for name in requested}
    clients = {name: node.create_client(service_type, f'/{name}/get_parameters')
               for name in requested}
    pending = {}
    complete = set()
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline and len(complete) < len(requested):
            for name, client in clients.items():
                if name in complete:
                    continue
                if name not in pending and client.service_is_ready():
                    request = service_type.Request()
                    request.names = requested[name]
                    pending[name] = client.call_async(request)
                    reports[name]['status'] = 'timeout'
                future = pending.get(name)
                if future is not None and future.done():
                    try:
                        response = future.result()
                        if len(response.values) != len(requested[name]):
                            raise ValueError('unexpected parameter count')
                        values = {key: decode(value)
                                  for key, value in zip(requested[name], response.values)}
                        reports[name] = {'status': 'ok', 'values': {
                            key: value for key, value in values.items() if value is not None}}
                    except Exception:
                        reports[name] = {'status': 'error', 'values': {}}
                    complete.add(name)
            spin_once(node, timeout_sec=min(0.05, max(0, deadline - time.monotonic())))
        return reports
    finally:
        for client in clients.values():
            node.destroy_client(client)


def main():
    """Read allowed parameter names from stdin and return JSON, then release the ROS node."""
    import rclpy
    from rcl_interfaces.srv import GetParameters
    from rclpy.parameter import parameter_value_to_python

    requested = json.load(sys.stdin)
    rclpy.init(args=[])
    node = None
    try:
        node = rclpy.create_node(f'questix_manager_read_{os.getpid()}',
                                enable_rosout=False, start_parameter_services=False)
        reports = collect(node, requested, rclpy.spin_once, parameter_value_to_python, GetParameters)
        print(json.dumps(reports, allow_nan=False))
    finally:
        if node is not None:
            node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
