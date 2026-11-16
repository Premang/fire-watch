#!/usr/bin/env python3
"""Resume a fixed WildfireSpreadTS subset via verified public ZIP byte ranges.
No credentials, label-based selection, or 48GB archive download is needed.
Python standard library only. Run from any directory; the fixed plan is beside
this script and the default cache is app/work/wfts-data (Git-ignored).
Dataset: https://zenodo.org/records/8006177 ; license: CC-BY-4.0.
"""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, io, json, re, struct, time, urllib.request, zipfile, zlib
from datetime import datetime, timezone
from pathlib import Path

SOURCE = 'https://zenodo.org/records/8006177/files/WildfireSpreadTS.zip?download=1'
ARCHIVE_BYTES = 48359369821
ROOT = Path(__file__).resolve().parent
ENTRY = re.compile(r'20(?:18|19|20|21)/fire_\d+/20\d\d-\d\d-\d\d\.tif\Z')
MAX_MEMBER_BYTES = 12_000_000

def utc(): return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False))
    temporary.replace(path)

def byte_range(start, count, attempts=5):
    if start < 0 or count < 1 or count > 16_000_000 or start+count > ARCHIVE_BYTES:
        raise ValueError('Unsafe archive range')
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(SOURCE, headers={'Range': f'bytes={start}-{start+count-1}', 'User-Agent': 'EmberAtlas-Research/1.0 (public wildfire dataset subset)'})
            with urllib.request.urlopen(req, timeout=40) as response:
                expected = f'bytes {start}-{start+count-1}/{ARCHIVE_BYTES}'
                if response.status != 206 or response.headers.get('Content-Range') != expected:
                    raise ValueError(f'Unexpected archive response: HTTP {response.status}, Content-Range {response.headers.get("Content-Range")}')
                content = response.read(count + 1)
                if len(content) != count: raise ValueError('Truncated or oversized byte range')
                return content
        except Exception as error:
            last = error
            if attempt + 1 < attempts: time.sleep(min(12, 2**attempt))
    raise RuntimeError(f'Range {start}+{count} failed after {attempts} attempts: {last}')

class RemoteArchive(io.RawIOBase):
    def __init__(self): self.position = 0
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.position
    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else ARCHIVE_BYTES + offset
        return self.position
    def read(self, count=-1):
        count = ARCHIVE_BYTES-self.position if count < 0 else min(count, ARCHIVE_BYTES-self.position)
        if not count: return b''
        data = byte_range(self.position, count); self.position += len(data); return data

def archive_index(output):
    cache = output / 'archive-index.json'
    if cache.exists():
        data = json.loads(cache.read_text())
        if data.get('source') == SOURCE and data.get('archiveBytes') == ARCHIVE_BYTES: return data['entries']
    with zipfile.ZipFile(RemoteArchive()) as archive:
        entries = {info.filename: {'bytes': info.file_size, 'compressedBytes': info.compress_size, 'offset': info.header_offset, 'compression': info.compress_type, 'crc32': info.CRC} for info in archive.infolist() if info.filename.endswith('.tif')}
    atomic_json(cache, {'source': SOURCE, 'archiveBytes': ARCHIVE_BYTES, 'readAt': utc(), 'entries': entries})
    return entries

def verify(data, meta):
    if len(data) != meta['bytes'] or (zlib.crc32(data) & 0xffffffff) != meta['crc32']:
        raise ValueError('ZIP member size or CRC32 mismatch')
    if data[:4] not in [b'II*\x00', b'MM\x00*', b'II+\x00', b'MM\x00+']:
        raise ValueError('Archive member is not a TIFF')
    return hashlib.sha256(data).hexdigest()

def download(item, meta, output):
    name = item['name']
    if not ENTRY.fullmatch(name): raise ValueError('Invalid planned ZIP entry path')
    if meta['bytes'] > MAX_MEMBER_BYTES or meta['compressedBytes'] > MAX_MEMBER_BYTES: raise ValueError('Member exceeds safe size')
    destination = output / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    reused = False
    if destination.exists():
        try: digest = verify(destination.read_bytes(), meta); reused = True
        except ValueError: pass
    if not reused:
        # One request includes bounded local header/extra fields and compressed member.
        count = 4096 + len(name.encode('utf-8')) + meta['compressedBytes']
        raw = byte_range(meta['offset'], count)
        header = struct.unpack('<IHHHHHIIIHH', raw[:30])
        signature, _, flags, compression, _, _, crc, _, _, name_len, extra_len = header
        if signature != 0x04034b50 or flags & 1 or compression != meta['compression']:
            raise ValueError('Unexpected ZIP local header')
        actual_name = raw[30:30+name_len].decode('utf-8')
        if actual_name != name: raise ValueError('ZIP filename differs from fixed plan')
        start = 30 + name_len + extra_len
        compressed = raw[start:start+meta['compressedBytes']]
        if len(compressed) != meta['compressedBytes']: raise ValueError('ZIP header exceeds bounded fetch')
        if compression == 8:
            decoder = zlib.decompressobj(-15)
            data = decoder.decompress(compressed, meta['bytes']+1)
            if not decoder.eof or decoder.unconsumed_tail or len(data) != meta['bytes']: raise ValueError('Invalid bounded deflate stream')
        elif compression == 0: data = compressed
        else: raise ValueError('Unsupported ZIP compression')
        digest = verify(data, meta)
        temporary = destination.with_suffix('.tif.part')
        temporary.write_bytes(data); temporary.replace(destination)
    return {'name': name, 'path': str(destination.resolve()), 'event': item['event'], 'split': item['split'], 'bytes': meta['bytes'], 'compressedBytes': meta['compressedBytes'], 'crc32': meta['crc32'], 'sha256': digest, 'verifiedAt': utc(), 'reused': reused}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=ROOT/'wfts-subset-plan.json')
    parser.add_argument('--output-dir', type=Path, default=ROOT.parents[1]/'work'/'wfts-data')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.workers <= 8: parser.error('--workers must be 1..8')
    output = args.output_dir.resolve(); output.mkdir(parents=True, exist_ok=True)
    plan_bytes = args.plan.read_bytes(); plan = json.loads(plan_bytes)
    index = archive_index(output)
    items = []
    for event in plan['selectionDetails']:
        for file in event['files']:
            if file['name'] not in index: raise ValueError('Planned member absent from published archive')
            meta = index[file['name']]
            if any(meta[k] != file[k] for k in ['bytes','compressedBytes','offset','compression']): raise ValueError('Source archive does not match fixed plan')
            items.append({**file, 'event': event['event'], 'split': event['split']})
    if len({item['name'] for item in items}) != len(items): raise ValueError('Duplicate planned member')
    results = {}; errors = {}; ready = set(); started = utc(); begin = time.monotonic()
    def checkpoint():
        events = [{**event, 'files': [results[f['name']] for f in event['files']]} for event in plan['selectionDetails'] if all(f['name'] in results for f in event['files'])]
        manifest = {'schemaVersion': 1, 'dataset': 'WildfireSpreadTS v1.0', 'license': 'CC-BY-4.0', 'source': SOURCE, 'archiveBytes': ARCHIVE_BYTES, 'planPath': str(args.plan.resolve()), 'planSha256': hashlib.sha256(plan_bytes).hexdigest(), 'startedAt': started, 'updatedAt': utc(), 'expectedFiles': len(items), 'verifiedFiles': len(results), 'readyEvents': len(events), 'complete': len(results) == len(items), 'errors': errors, 'files': [results[k] for k in sorted(results)]}
        atomic_json(output/'manifest.json', manifest)
        atomic_json(output/'ready-events.json', {'complete': manifest['complete'], 'events': events})
        for event in events:
            if event['event'] not in ready:
                ready.add(event['event'])
                print(json.dumps({'eventReady': event['event'], 'split': event['split'], 'readyEvents': len(ready), 'verifiedFiles': len(results), 'elapsedSeconds': round(time.monotonic()-begin,1)}), flush=True)
    checkpoint()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(download,item,index[item['name']],output):item for item in items}
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try: results[item['name']] = future.result(); errors.pop(item['name'],None)
            except Exception as error: errors[item['name']] = str(error); print(json.dumps({'failed': item['name'], 'error': str(error)}), flush=True)
            checkpoint()
    print(json.dumps({'complete': not errors, 'verifiedFiles': len(results), 'events': len(ready), 'elapsedSeconds': round(time.monotonic()-begin,1), 'manifest': str(output/'manifest.json')}), flush=True)
    if errors: raise SystemExit(1)
if __name__ == '__main__': main()
