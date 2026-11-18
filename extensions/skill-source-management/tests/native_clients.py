"""Opt-in native fixtures. No real provider credentials, sessions or candidate scripts."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import subprocess
import threading


def environment(home):
    # Deliberately do not inherit provider keys, CODEX_HOME, proxies or existing client settings.
    allowed = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'),
               XDG_CACHE_HOME=str(home / '.cache'), XDG_DATA_HOME=str(home / '.local/share'))
    return env


def codex_skills(executable, home, cwd):
    env = environment(home)
    with subprocess.Popen([executable, 'app-server', '--listen', 'stdio://'],
                          cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True) as process:
        messages = queue.Queue()
        def read():
            for line in process.stdout:
                try:
                    messages.put(json.loads(line))
                except ValueError:
                    continue
            messages.put({'closed': True})
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        def send(value):
            process.stdin.write(json.dumps(value) + '\n')
            process.stdin.flush()
        def response(identity):
            while True:
                value = messages.get(timeout=30)
                if value.get('closed'):
                    raise RuntimeError('Native Codex exited before its metadata response')
                if value.get('id') == identity:
                    if 'error' in value:
                        raise RuntimeError(value['error'])
                    return value['result']
        try:
            send({'id': 1, 'method': 'initialize', 'params': {
                'clientInfo': {'name': 'omh-skill-fixture', 'version': '1.0.0'},
                'capabilities': {'experimentalApi': True}}})
            response(1)
            send({'method': 'initialized', 'params': {}})
            send({'id': 2, 'method': 'skills/list', 'params': {'cwds': [str(cwd)], 'forceReload': True}})
            result = response(2)
            rows = result['data']
            errors = [error for row in rows for error in row.get('errors', [])]
            if errors:
                raise RuntimeError(errors)
            return [skill for row in rows for skill in row['skills']]
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            reader.join(timeout=5)


@contextmanager
def anthropic_fixture():
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            requests.append({'path': self.path, 'body': body})
            if self.path.startswith('/v1/messages/count_tokens'):
                output = json.dumps({'input_tokens': 1}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(output)))
                self.end_headers()
                self.wfile.write(output)
                return
            if self.path.split('?')[0] != '/v1/messages':
                self.send_error(404)
                return
            message = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant',
                       'model': body.get('model', 'fixture'), 'content': [{'type': 'text', 'text': 'fixture-ok'}],
                       'stop_reason': 'end_turn', 'stop_sequence': None,
                       'usage': {'input_tokens': 1, 'output_tokens': 1}}
            if body.get('stream'):
                events = [
                    ('message_start', {'type': 'message_start', 'message': {**message, 'content': [], 'stop_reason': None}}),
                    ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                    ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'fixture-ok'}}),
                    ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                    ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}),
                    ('message_stop', {'type': 'message_stop'})]
                output = ''.join(f'event: {name}\ndata: {json.dumps(value)}\n\n' for name, value in events).encode()
                content_type = 'text/event-stream'
            else:
                output = json.dumps(message).encode()
                content_type = 'application/json'
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(output)))
            self.end_headers()
            self.wfile.write(output)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def claude_request(executable, home, cwd, prompt):
    with anthropic_fixture() as (endpoint, requests):
        env = environment(home)
        env.update(CLAUDE_CONFIG_DIR=str(home / '.claude'), ANTHROPIC_API_KEY='local-fixture-not-a-credential',
                   ANTHROPIC_BASE_URL=endpoint, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',
                   DISABLE_AUTOUPDATER='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1')
        result = subprocess.run([executable, '--print', '--output-format', 'json',
                                 '--model', 'claude-sonnet-4-6', '--no-session-persistence', '--no-chrome',
                                 '--tools', '', '--permission-mode', 'dontAsk', '--setting-sources', 'user',
                                 '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--', prompt],
                                cwd=cwd, env=env, capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError(f'Native Claude exited {result.returncode}: {result.stderr[-1000:]} {result.stdout[-1000:]}')
        return [request['body'] for request in requests if request['path'].split('?')[0] == '/v1/messages'], result.stdout
