"""Run the built image with its real Node runtime: readiness, revision, every game's page and API, and a graceful stop.

The image's APP_BASE_PATH (a build arg) decides where the games live; /health also answers at the root.
OPPER_SSM_PREFIXES='[]' makes the loadsecrets entrypoint skip SSM, as it does outside AWS.
"""
import json
import os
import secrets
import subprocess
import sys
import time
from datetime import datetime
import urllib.error
import urllib.request

sha = os.environ['GITHUB_SHA']
image_env = json.loads(subprocess.check_output(['docker', 'image', 'inspect', sys.argv[1]]))[0]['Config']['Env'] or []
base = next((e.split('=', 1)[1] for e in image_env if e.startswith('APP_BASE_PATH=')), '').rstrip('/')
# Without the https address it is served at, a production image must refuse to start.
refused = subprocess.run(['docker', 'run', '--rm', '--env', 'OPPER_SSM_PREFIXES=[]', sys.argv[1]], capture_output=True, text=True, timeout=60)
assert refused.returncode != 0 and 'PUBLIC_BASE_URL' in refused.stderr, (refused.returncode, refused.stderr)
container = subprocess.check_output([
    'docker', 'run', '-d', '--publish', '127.0.0.1::3000', '--env', 'PUBLIC_BASE_URL=https://opper.ai',
    '--env', 'SESSION_SECRET=' + secrets.token_hex(32),  # an https deployment needs one; this one is thrown away
    '--env', 'SOURCE_COMMIT=' + sha, '--env', 'OPPER_SSM_PREFIXES=[]', sys.argv[1],
], text=True).strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def status_of(address):
    try:
        with urllib.request.build_opener(NoRedirect).open(address, timeout=2) as response:
            return response.status, response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.headers


try:
    port = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
    root = 'http://127.0.0.1:' + port
    url = root + base
    deadline = time.monotonic() + 45
    while True:
        try:
            with urllib.request.urlopen(root + '/health', timeout=2) as response:
                assert response.status == 200
            break
        except (urllib.error.URLError, OSError):
            if time.monotonic() > deadline:
                raise RuntimeError('Image never became ready')
            time.sleep(0.5)
    with urllib.request.urlopen(url + '/health', timeout=2) as response:
        assert response.status == 200
    if base:
        code, headers = status_of(root + base)
        assert (code, headers['Location']) == (308, base + '/'), (code, headers['Location'])
        for outside in ('/', '/api/me', base + '/no-such-game/'):
            assert status_of(root + outside)[0] == 404, outside
    with urllib.request.urlopen(url + '/revision', timeout=2) as response:
        revision = json.load(response)
    assert revision['app'] == 'decision-benchmarks' and revision['commit'] == sha and revision['draining'] is False, revision
    # Every game the image serves: its page, built for its path, its hub files, and its API without a key.
    for game in revision['games']:
        at = url + '/' + game
        code, headers = status_of(at)
        assert (code, headers['Location']) == (308, base + '/' + game + '/'), (game, code, headers['Location'])
        with urllib.request.urlopen(at + '/', timeout=2) as response:
            page = response.read().decode()
        assert '%VITE_' not in page, game + ': a %VITE_...% placeholder was left in index.html'
        assert f'src="{base}/{game}/assets/' in page, game + ': index.html was built for another path'
        with urllib.request.urlopen(at + '/game.json', timeout=2) as response:
            info = json.load(response)
        assert info['slug'] == game, game
        datetime.fromisoformat(info['updatedAt'])  # the build sets it from the newest results
        with urllib.request.urlopen(at + '/poster.png', timeout=2) as response:
            assert response.headers['Content-Type'] == 'image/png', (game, response.headers['Content-Type'])
        with urllib.request.urlopen(at + '/api/me', timeout=2) as response:
            me = json.load(response)
        assert me['mode'] == 'none', me  # no server key in the image
        request = urllib.request.Request(at + '/api/decide', data=b'{}', headers={'Content-Type': 'application/json'})
        try:
            urllib.request.urlopen(request, timeout=2)
            raise AssertionError('/api/decide should refuse without a key')
        except urllib.error.HTTPError as error:
            assert error.code == 401, error.code
    started = time.monotonic()
    # ECS waits 30 s (stopTimeout) after SIGTERM before SIGKILL; the server must exit cleanly within that.
    subprocess.run(['docker', 'stop', '--time', '30', container], check=True, stdout=subprocess.DEVNULL)
    state = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]['State']
    assert state['ExitCode'] == 0, state
    print(f'Container smoke passed at {base or "/"}: {json.dumps(revision)}; graceful stop in {time.monotonic() - started:.1f}s')
finally:
    subprocess.run(['docker', 'logs', container], check=False)
    subprocess.run(['docker', 'rm', '-f', container], check=False, stdout=subprocess.DEVNULL)
