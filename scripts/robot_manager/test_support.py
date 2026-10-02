"""Shared import shims for the robot_manager helper tests.

The helper tests are plain ``unittest`` modules so they can run on a developer
machine (or in CI) without installing the FastAPI/Pydantic runtime that the
service itself needs. Importing this module first installs minimal substitutes
when those packages are absent, so ``robot_manager.recorder`` and friends can be
imported for their pure helper functions.
"""

import sys
import types


def _install_fastapi_stub() -> None:
    if "fastapi" in sys.modules:
        return
    try:
        import fastapi  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    stub = types.ModuleType("fastapi")

    class HTTPException(Exception):
        """Minimal FastAPI HTTPException substitute for helper tests."""

        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class APIRouter:
        """Minimal route decorator substitute for importing helper modules."""

        def __init__(self, *args, **kwargs):
            pass

        def _route(self, *args, **kwargs):
            return lambda function: function

        get = post = put = delete = _route

    stub.APIRouter = APIRouter
    stub.HTTPException = HTTPException
    sys.modules["fastapi"] = stub


def _install_pydantic_stub() -> None:
    if "pydantic" in sys.modules:
        return
    try:
        import pydantic  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    stub = types.ModuleType("pydantic")

    class BaseModel:
        """Minimal Pydantic model substitute for importing helper modules."""

    def field_validator(*args, **kwargs):
        return lambda function: function

    stub.BaseModel = BaseModel
    stub.field_validator = field_validator
    sys.modules["pydantic"] = stub


def install_stubs() -> None:
    """Install FastAPI/Pydantic substitutes when the real packages are missing."""
    _install_fastapi_stub()
    _install_pydantic_stub()
