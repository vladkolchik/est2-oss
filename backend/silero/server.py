# Minimal Silero TTS HTTP server (stdlib + torch only).
# Managed by backend/sileroManager.js — started automatically with the backend.
#
# API:
#   GET  /health -> {"ok": true, "model": "...", "ready": true}
#   POST /tts    {"text": "...", "speaker": "en_0", "sample_rate": 48000} -> audio/wav

import argparse
import io
import json
import os
import re
import sys
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

MODEL_URLS = {
    'v3_en': 'https://models.silero.ai/models/tts/en/v3_en.pt',
    'v4_ru': 'https://models.silero.ai/models/tts/ru/v4_ru.pt',
    'v3_de': 'https://models.silero.ai/models/tts/de/v3_de.pt',
    'v3_es': 'https://models.silero.ai/models/tts/es/v3_es.pt',
    'v3_fr': 'https://models.silero.ai/models/tts/fr/v3_fr.pt',
}

VALID_SAMPLE_RATES = (8000, 24000, 48000)
# Silero degrades / errors on very long inputs; synthesize in chunks and concatenate.
MAX_CHUNK_CHARS = 800


def load_model(model_id, models_dir, threads):
    torch.set_num_threads(max(1, threads))
    os.makedirs(models_dir, exist_ok=True)
    local_path = os.path.join(models_dir, f'{model_id}.pt')
    if not os.path.isfile(local_path):
        url = MODEL_URLS.get(model_id)
        if not url:
            raise ValueError(f'Unknown Silero model id: {model_id}. Known: {", ".join(MODEL_URLS)}')
        print(f'[silero] downloading model {model_id} from {url} ...', flush=True)
        tmp_path = local_path + '.part'
        urllib.request.urlretrieve(url, tmp_path)
        os.replace(tmp_path, local_path)
        print('[silero] model downloaded', flush=True)

    from torch.package import PackageImporter
    importer = PackageImporter(local_path)
    model = importer.load_pickle('tts_models', 'model')
    model.to(torch.device('cpu'))
    return model


def split_text(text, limit=MAX_CHUNK_CHARS):
    text = text.strip()
    if len(text) <= limit:
        return [text]
    sentences = re.split(r'(?<=[.!?…])\s+', text)
    chunks, current = [], ''
    for sentence in sentences:
        candidate = f'{current} {sentence}'.strip() if current else sentence
        if len(candidate) <= limit:
            current = candidate
        else:
            if current:
                chunks.append(current)
            # A single overlong sentence is hard-split.
            while len(sentence) > limit:
                chunks.append(sentence[:limit])
                sentence = sentence[limit:]
            current = sentence
    if current:
        chunks.append(current)
    return chunks


class Handler(BaseHTTPRequestHandler):
    model = None
    model_id = None
    default_speaker = None

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._send_json(200, {'ok': True, 'ready': True, 'model': self.model_id})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path not in ('/tts', '/'):
            return self._send_json(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('content-length') or 0)
            payload = json.loads(self.rfile.read(length) or b'{}')
            text = str(payload.get('text') or '').strip()
            if not text:
                return self._send_json(400, {'error': 'missing text'})

            speaker = str(payload.get('speaker') or self.default_speaker)
            sample_rate = int(payload.get('sample_rate') or 48000)
            if sample_rate not in VALID_SAMPLE_RATES:
                sample_rate = 48000

            pieces = []
            for chunk in split_text(text):
                audio = self.model.apply_tts(text=chunk, speaker=speaker, sample_rate=sample_rate)
                pieces.append(audio)
            audio = torch.cat(pieces) if len(pieces) > 1 else pieces[0]

            pcm = (audio * 32767.0).clamp(-32768, 32767).to(torch.int16).numpy().tobytes()
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sample_rate)
                w.writeframes(pcm)
            body = buf.getvalue()

            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send_json(500, {'error': str(e)})
            except Exception:
                pass

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8010)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--model', default='v3_en')
    parser.add_argument('--speaker', default='en_0')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--models-dir', default=os.path.join(os.path.dirname(__file__), 'models'))
    args = parser.parse_args()

    Handler.model = load_model(args.model, args.models_dir, args.threads)
    Handler.model_id = args.model
    Handler.default_speaker = args.speaker

    # Warm up so the first real request is not slow.
    try:
        Handler.model.apply_tts(text='Ready.', speaker=args.speaker, sample_rate=24000)
    except Exception as e:
        print(f'[silero] warmup failed (speaker "{args.speaker}" valid for model "{args.model}"?): {e}', flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'[silero] ready on http://{args.host}:{args.port} (model={args.model})', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    sys.exit(main())
