"""Run only inside the isolated builder; the repository mount is read-only."""

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path('/workspace')
OUT = Path('/out')
COMMIT = 'f498a16c7db6d4b2de200b3e0856528dfe0613c3'
ARCHIVE_SHA256 = 'fdde97e0d253522e731f3ad62204a12c04c6e159d69e44dfbcac66fd740680cb'


def run(*args, **kwargs):
    print('+', ' '.join(str(arg) for arg in args), flush=True)
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'tools/native-build/.cache/micropython'
    # Check the pinned commit without depending on Git inside the image.
    if (source / '.git/HEAD').read_text().strip() != COMMIT:
        raise RuntimeError('Expected the verified MicroPython v1.25.0 commit; refusing a different source tree')
    work = Path('/tmp/xrp-native-build')
    work.mkdir(exist_ok=True)
    mp = work / 'micropython'
    archive = source.parent / 'micropython-v1.25.0.tar'
    archive_bytes = archive.read_bytes()
    if hashlib.sha256(archive_bytes).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError('MicroPython source archive hash does not match the pinned commit')
    print('Extracting verified source into container-local temporary storage', flush=True)
    mp.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as source_tar:
        # The pinned Git archive contains only files/directories, no links.
        for member in source_tar.getmembers():
            if (not (member.isfile() or member.isdir()) or member.name.startswith('/')
                    or '..' in Path(member.name).parts):
                raise RuntimeError('Unsafe source archive entry')
        source_tar.extractall(mp)
    code = ROOT / 'XRP_MicroPython/native/xrp_comm'
    run('gcc', '-std=c99', '-Wall', '-Wextra', '-Werror', '-g', '-fsanitize=address,undefined',
        '-I' + str(code), code / 'xrp_codec.c', ROOT / 'tools/native-build/test_codec_core.c',
        '-o', work / 'test-codec-core')
    run(work / 'test-codec-core')
    run('make', '-C', mp / 'ports/unix', '-j2', 'FROZEN_MANIFEST=',
        'MICROPY_PY_SSL=0', 'MICROPY_PY_BTREE=0', 'MICROPY_PY_FFI=0',
        'MICROPY_VFS_FAT=0', 'MICROPY_VFS_LFS1=0', 'MICROPY_VFS_LFS2=0', 'MICROPY_PY_THREAD=0')
    manifest = {'micropython_tag': 'v1.25.0', 'micropython_commit': COMMIT,
                'hardware_verified': False, 'artifacts': []}
    for arch in ('x64', 'armv6m', 'armv7m'):
        module = work / ('module-' + arch)
        shutil.copytree(code, module, dirs_exist_ok=True)
        run('make', '-C', module, 'MPY_DIR=' + str(mp), 'ARCH=' + arch)
        destination = OUT / arch
        destination.mkdir(exist_ok=True)
        target = destination / 'xrp_comm_native.mpy'
        shutil.copy2(module / target.name, target)
        binary = target.read_bytes()
        if binary[:2] != b'M\x06':
            raise RuntimeError('Unexpected native module header')
        manifest['artifacts'].append({'arch': arch, 'mpy_version': binary[1],
            'mpy_sub_version': binary[2] & 3, 'native_arch_id': binary[2] >> 2,
            'required_small_int_bits': binary[3], 'size_bytes': len(binary),
            'sha256': hashlib.sha256(binary).hexdigest()})
        if arch == 'x64':
            env = dict(os.environ, MICROPYPATH=str(destination) + ':' + str(ROOT / 'XRP_MicroPython'))
            run(mp / 'ports/unix/build-standard/micropython',
                ROOT / 'XRP_MicroPython/tests/native_codec_contract.py', env=env)
            benchmark = subprocess.run([str(mp / 'ports/unix/build-standard/micropython'),
                str(ROOT / 'XRP_MicroPython/XRPExamples/native_comm_benchmark.py')],
                env=env, check=True, capture_output=True, text=True)
            lines = benchmark.stdout.splitlines()
            first = lines.index('NATIVE_BENCHMARK_BEGIN')
            report = json.loads(lines[first + 1])
            assert report['measurement'] == 'offline_cpu_not_rtt' and len(report['results']) == 9
            report['execution_environment'] = 'Linux x64 container, NOT XRP hardware'
            (OUT / 'host-cpu-benchmark.json').write_text(json.dumps(report, indent=2) + '\n')
            print('HOST_BENCHMARK_OK: actual native module; CPU timings are not robot RTT results', flush=True)
    manifest['source_sha256'] = {name: hashlib.sha256((code / name).read_bytes()).hexdigest()
                                for name in ('xrp_codec.c', 'xrp_codec.h', 'xrp_comm_native.c', 'Makefile')}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('BUILD_OK: ARM modules compiled; native x64 module executed; no robot firmware changed.', flush=True)


if __name__ == '__main__':
    main()
