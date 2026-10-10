"""Reviewed artifact identity checks use only private temporary files."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'review_manifest', Path(__file__).parents[1] / 'deploy/review_manifest.py')
manifest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manifest)


class ReviewManifestTest(unittest.TestCase):
    def test_old_binary_changes_and_missing_dependencies_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            prefix = Path(folder)
            digest = manifest.hashlib.sha256(b'').hexdigest()
            marker = b'QUESTIX_RP1_REVIEW_V2:' + digest.encode()
            for name in manifest.REQUIRED:
                file = prefix / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'\x7fELF\x02\x01' + b'\x00' * 12 + b'\xb7\x00' + marker)
            for package in manifest.PACKAGES[:-1] + ('questix_launcher',):
                file = prefix / package / 'share' / package / 'package.xml'
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('<package/>')
            data = dict(schema=2, contract='rp1-reviewed-v2', prefix=str(prefix),
                        source_digest=digest, source_files={}, install_files=manifest.install_files(prefix))
            self.assertEqual(manifest.verify(data, arm64=True), prefix)
            binary = prefix / manifest.ELFS[2]
            binary.write_bytes(b'old ARM64 executable')
            with self.assertRaises(ValueError):
                manifest.verify(data, arm64=True)
            # Even a freshly re-hashed archive cannot relabel an old executable as this source.
            data['install_files'] = manifest.install_files(prefix)
            with self.assertRaises(ValueError):
                manifest.verify(data)

    def test_trusted_manifest_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'manifest.json'
            file.write_text('{}')
            file.chmod(0o644)
            with self.assertRaises(ValueError):
                manifest.trusted_json(file)


if __name__ == '__main__':
    unittest.main()
