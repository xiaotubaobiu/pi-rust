"""Read-only, serial HTTP test diagnostics; never changes OS proxy or repository sources."""
import hashlib
import json
import os
import subprocess
import sys
import winreg
from datetime import datetime
from pathlib import Path
import psutil

REPO = Path(__file__).resolve().parents[3]
LOGS = REPO / 'docs/migration/validation'
HTTP = 'ai::images::openrouter_images::tests::http_error_yields_formatted_error_result'
CASES = [
    ('A-inherited-environment', HTTP, {}),
    ('B-loopback-bypass', HTTP, {'NO_PROXY': 'localhost,127.0.0.1,::1'}),
    ('A-repeat-inherited-environment', HTTP, {}),
    ('B-radius-loopback-bypass', 'ai::auth::oauth::radius::tests::browser_flow_exchanges_the_callback_code_through_the_gateway', {'NO_PROXY': 'localhost,127.0.0.1,::1'}),
    ('B-kimi-loopback-bypass', 'ai::auth::oauth::kimi_coding::tests::invalid_grant_fails_unauthorized_without_retrying', {'NO_PROXY': 'localhost,127.0.0.1,::1'}),
    ('B-model-loopback-bypass', 'ai::models::tests::stream_simple_round_trips_resolved_auth_over_http', {'NO_PROXY': 'localhost,127.0.0.1,::1'}),
]

def now():
    return datetime.now().astimezone().isoformat()

def main():
    path = LOGS / (datetime.now().strftime('%Y-%m-%d-%H%M%S') + '-component-screen-widgets-http-ab.log')
    print('LOG', path, flush=True)
    with path.open('xb') as out:
        def line(s):
            out.write((s + '\n').encode('utf-8')); out.flush()
        line('DIAGNOSTIC START ' + now())
        line('SCRIPT SHA256 ' + hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
        keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'CARGO_HTTP_PROXY']
        line('Proxy environment presence only: ' + json.dumps({k: k in os.environ for k in keys}))
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as key:
            for name in ['ProxyEnable', 'ProxyServer', 'ProxyOverride']:
                value = winreg.QueryValueEx(key, name)[0]
                if name == 'ProxyServer' and ('@' in str(value) or '://' in str(value)):
                    value = '<present; value redacted>'
                line('READ ONLY HKCU ' + name + '=' + str(value))
        results = []
        for label, test, changes in CASES:
            cmd = ['cargo', 'test', '--offline', '--lib', test, '--', '--exact', '--nocapture']
            line('LABEL ' + label + ' ENVIRONMENT_OVERLAY ' + json.dumps(changes))
            line('COMMAND ' + ' '.join(cmd) + ' START ' + now())
            env = dict(os.environ); env.update(changes)
            proc = subprocess.Popen(cmd, cwd=REPO, env=env, stdout=out, stderr=subprocess.STDOUT)
            try:
                code = proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                line('DIAGNOSTIC TIMEOUT 60s; only descendants of this launched cargo process will be stopped')
                root = psutil.Process(proc.pid)
                children = root.children(recursive=True)
                for p in children:
                    line('OWNED DESCENDANT ' + json.dumps({'pid':p.pid, 'ppid':p.ppid(), 'name':p.name(), 'create_time':p.create_time()}))
                for p in reversed(children):
                    try: p.kill()
                    except psutil.NoSuchProcess: pass
                try: root.kill()
                except psutil.NoSuchProcess: pass
                code = proc.wait()
                line('TIMEOUT_RESULT_NOT_A_TEST_PASS')
            line('EXIT=' + str(code) + ' END ' + now())
            results.append({'label':label,'exit':code})
            print(label, 'exit', code, flush=True)
        line('RESULTS ' + json.dumps(results))
    print('CLOSED', path, flush=True)
    print(json.dumps(results), flush=True)

if __name__ == '__main__':
    main()
