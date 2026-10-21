"""Bounded recorder settings without ROS, hardware or real configuration writes."""

import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Response
from pydantic import ValidationError

from robot_manager import recorder


class RecorderNumericTests(unittest.TestCase):
    """Exercise public settings and both recording entry points with isolated seams."""

    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = dict(recorder._DEFAULT_CONFIG, OUTPUT_DIR=self.temp.name)
        self.enterContext(patch.object(recorder, '_read_config', lambda: self.config.copy()))
        self.write = self.enterContext(patch.object(recorder, '_write_config'))
        self.usage = self.enterContext(patch.object(
            recorder.shutil, 'disk_usage', return_value=SimpleNamespace(
                free=24 * 1024**3, total=32 * 1024**3)))

    def test_invalid_strings_never_save(self):
        for key in ('MIN_FREE_GB', 'MAX_SPLIT_MB', 'MAX_DURATION_SEC'):
            for value in ('²', '５', '-1', '1.5', '', ' 1', '1 ', '+1', '1e1', '9' * 5000):
                with self.subTest(key=key, value=value[:20]):
                    with self.assertRaises(ValidationError) as error:
                        recorder.RecorderConfig(**{key: value})
                    message = str(error.exception)
                    self.assertIn('半角の数字', message)
                    self.assertIn('0', message)
        self.write.assert_not_called()

    def test_non_string_numbers_are_rejected(self):
        for value in (1, 1.0, True):
            with self.assertRaises(ValidationError):
                recorder.RecorderConfig(MIN_FREE_GB=value)

    def test_boundaries(self):
        for key, good, bad in (
            ('MIN_FREE_GB', ('1', '16', '005'), ('0', '17')),
            ('MAX_SPLIT_MB', ('0', '1', '8192'), ('8193',)),
            ('MAX_DURATION_SEC', ('0', '1', '14400'), ('14401',)),
        ):
            for value in good:
                with self.subTest(key=key, value=value):
                    saved = recorder.set_config(recorder.RecorderConfig(**{key: value}))
                    self.assertEqual(saved[key], value)
            for value in bad:
                with self.assertRaises(ValidationError):
                    recorder.RecorderConfig(**{key: value})

    def test_capacity_is_strict_and_uses_total(self):
        for total, accepted in ((5 * 1024**3 - 1, False), (5 * 1024**3, False),
                                (5 * 1024**3 + 1, True)):
            self.usage.return_value = SimpleNamespace(total=total, free=0)
            request = recorder.RecorderConfig(MIN_FREE_GB='5')
            if accepted:
                recorder.set_config(request)
            else:
                with self.assertRaises(HTTPException) as error:
                    recorder.set_config(request)
                self.assertEqual(error.exception.status_code, 422)

    def test_missing_directory_uses_existing_parent_without_creating(self):
        target = Path(self.temp.name) / 'missing' / 'bags'
        recorder.set_config(recorder.RecorderConfig(OUTPUT_DIR=str(target)))
        self.usage.assert_called_with(Path(self.temp.name))
        self.assertFalse(target.exists())

    def test_unavailable_capacity_or_invalid_target_never_writes(self):
        for failure in (OSError('unavailable'), PermissionError('denied')):
            self.usage.side_effect = failure
            with self.assertRaises(HTTPException) as error:
                recorder.set_config(recorder.RecorderConfig(MIN_FREE_GB='1'))
            self.assertEqual(error.exception.status_code, 503)
        self.usage.side_effect = None
        self.usage.return_value.total = 0
        with self.assertRaises(HTTPException):
            recorder.set_config(recorder.RecorderConfig(MIN_FREE_GB='1'))
        target = Path(self.temp.name) / 'file'
        target.write_text('file')
        with self.assertRaises(HTTPException):
            recorder.set_config(recorder.RecorderConfig(OUTPUT_DIR=str(target / 'bags')))
        target.unlink()
        target.symlink_to(Path(self.temp.name) / 'absent')
        with self.assertRaises(HTTPException):
            recorder.set_config(recorder.RecorderConfig(OUTPUT_DIR=str(target / 'bags')))
        self.write.assert_not_called()

    def test_folder_only_save_requires_repair_of_saved_numeric_values(self):
        for key, value, limit in (('MIN_FREE_GB', '²', '1〜16'),
                                  ('MAX_SPLIT_MB', '8193', '0〜8192'),
                                  ('MAX_DURATION_SEC', '-1', '0〜14400')):
            self.config = dict(recorder._DEFAULT_CONFIG, OUTPUT_DIR=self.temp.name)
            self.config[key] = value
            self.write.reset_mock()
            target = str(Path(self.temp.name) / 'bags')
            with self.assertRaises(HTTPException) as error:
                recorder.set_config(recorder.RecorderConfig(OUTPUT_DIR=target))
            self.assertIn(key, error.exception.detail)
            self.assertIn(limit, error.exception.detail)
            self.write.assert_not_called()
            recorder.set_config(recorder.RecorderConfig(**{
                'OUTPUT_DIR': target, key: recorder._DEFAULT_CONFIG[key]}))
            self.write.assert_called_once()

    def test_invalid_minimum_falls_back_with_warnings_without_rewriting(self):
        for value in ('²', '５', '-1', '0', '17', '9' * 5000):
            self.config['MIN_FREE_GB'] = value
            self.assertEqual(recorder._min_free_bytes(self.config), 5 * 1024**3)
            for data in (recorder.get_config(), recorder._status_payload()):
                self.assertTrue(data['config_warnings'])
                self.assertIn('5 GB', data['config_warnings'][0])
            self.assertEqual(recorder.get_config()['MIN_FREE_GB'], value)
        self.write.assert_not_called()

    def test_readiness_uses_fallback_and_reports_invalid_split(self):
        self.config['MIN_FREE_GB'] = '²'
        with patch.object(recorder.readiness, 'service', return_value='active'):
            data = recorder.get_readiness(Response())
            self.assertTrue(data['normal']['ready'])
            self.assertEqual(data['output']['min_free_bytes'], 5 * 1024**3)
            self.assertTrue(data['config_warnings'])
            self.config['MAX_SPLIT_MB'] = '8193'
            data = recorder.get_readiness(Response())
            self.assertFalse(data['normal']['ready'])
            self.assertIn('MAX_SPLIT_MB', str(data['common_checks']))

    def test_invalid_split_or_duration_blocks_both_starts_before_side_effects(self):
        for key in ('MAX_SPLIT_MB', 'MAX_DURATION_SEC'):
            for value in ('²', '５', '-1', '999999'):
                self.config = dict(recorder._DEFAULT_CONFIG, OUTPUT_DIR=self.temp.name)
                self.config[key] = value
                for start in (recorder.start_recording, lambda: recorder._start_trial({})):
                    with patch.object(recorder, '_require_robot_service'), \
                            patch.object(recorder, '_starting', False), \
                            patch.object(recorder, '_capturing', False), \
                            patch.object(recorder, '_proc', None), \
                            patch.object(Path, 'mkdir') as mkdir, \
                            patch.object(recorder.subprocess, 'Popen') as popen, \
                            patch.object(recorder, '_classroom_preflight') as ros:
                        with self.assertRaises(HTTPException) as error:
                            start()
                        self.assertEqual(error.exception.status_code, 400)
                        mkdir.assert_not_called()
                        popen.assert_not_called()
                        ros.assert_not_called()

    def test_fallback_minimum_still_refuses_low_space(self):
        self.config['MIN_FREE_GB'] = '0'
        self.usage.return_value.free = 5 * 1024**3 - 1
        with self.assertRaises(HTTPException) as error:
            recorder._prepare_output(self.config)
        self.assertEqual(error.exception.status_code, 507)

    def test_api_rejections_serialize_and_keep_reasons(self):
        app = FastAPI()
        app.include_router(recorder.router)
        async def request(payload):
            messages = []

            async def receive():
                return {'type': 'http.request', 'body': json.dumps(payload).encode()}

            async def send(message):
                messages.append(message)

            await app({'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'},
                       'method': 'PUT', 'scheme': 'http', 'path': '/api/rosbag/config',
                       'query_string': b'', 'headers': [(b'content-type', b'application/json')]},
                      receive, send)
            status = next(m['status'] for m in messages if m['type'] == 'http.response.start')
            body = b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body')
            return status, json.loads(body)

        status, body = asyncio.run(request({'MIN_FREE_GB': '²'}))
        self.assertEqual(status, 422)
        self.assertIn('半角の数字', body['detail'][0]['msg'])
        self.config['MAX_DURATION_SEC'] = '14401'
        status, body = asyncio.run(request({'OUTPUT_DIR': self.temp.name}))
        self.assertEqual(status, 422)
        self.assertIn('MAX_DURATION_SEC', body['detail'])
        self.assertIn('0〜14400', body['detail'])
        status, _body = asyncio.run(request({'MAX_DURATION_SEC': '10'}))
        self.assertEqual(status, 200)
        self.write.assert_called_once()

    def test_command_arguments_stay_identical(self):
        with patch.object(recorder, '_read_env_file', return_value={'ROS_DOMAIN_ID': '42'}):
            for split, duration in ((recorder._DEFAULT_CONFIG['MAX_SPLIT_MB'], '0'),
                                    ('0', '0'), ('8192', '14400')):
                config = dict(self.config, MAX_SPLIT_MB=split, MAX_DURATION_SEC=duration,
                              EXCLUDE_TOPICS='/scan /camera/image_raw')
                command = recorder._build_record_command(config, Path('/tmp/bag'))
                self.assertIn('export ROS_DOMAIN_ID=42;', command)
                self.assertIn('ros2 bag record -a -s mcap -o "/tmp/bag"', command)
                self.assertIn('-x "(/scan|/camera/image_raw)"', command)
                if int(split):
                    self.assertIn(f'--max-bag-size {int(split) * 1000**2}', command)
                else:
                    self.assertNotIn('--max-bag-size', command)
                if int(duration):
                    self.assertIn(f'--max-bag-duration {duration}', command)
                else:
                    self.assertNotIn('--max-bag-duration', command)


if __name__ == '__main__':
    unittest.main()
