"""Serial slice validation runner. Logs are created exclusively, never overwritten.
Node/Python paths may be overridden via NODE/PYTHON; no network/Git writes.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
REPO = Path(__file__).resolve().parents[3]
LOGS = REPO / 'docs/migration/validation'
SCOPE = ['src/tui/mod.rs', 'src/tui/tests.rs', 'src/tui/utils.rs', 'src/tui/utils/utf16.rs',
         'src/tui/alt_screen_search_index.rs', 'src/tui/tests/alt_screen_search_index.rs',
         'src/tui/alt_screen_search_index/fixtures.json', 'src/tui/alt_screen_search_index/simple_case_fold.rs']
def main():
    stage = sys.argv[1]
    flags = sys.argv[2:]
    if flags not in ([], ['--loopback-no-proxy']) or (flags and stage != 'gates'):
        raise SystemExit('Only gates accepts --loopback-no-proxy')
    overlay = {}
    if flags:
        existing = os.environ.get('NO_PROXY') or os.environ.get('no_proxy') or ''
        overlay['NO_PROXY'] = ','.join(filter(None, [existing, 'localhost,127.0.0.1,::1']))
    child_env = dict(os.environ)
    child_env.update(overlay)
    node = os.environ.get('NODE') or shutil.which('node')
    python = os.environ.get('PYTHON') or sys.executable
    if stage == 'test':
        commands = [['cargo','fmt','--all'], ['cargo','test','--offline','--lib','search_index','--','--nocapture']]
    elif stage == 'gates':
        commands = [['cargo','fmt','--all','--','--check'], ['cargo','clippy','--offline','--all-targets','--','-D','warnings'], ['cargo','test','--offline','--all-targets'], ['cargo','test','--offline','--doc']]
        witness = LOGS / ('alt-screen-search-gate-source-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.json')
        with witness.open('x', encoding='utf8') as f:
            json.dump({'recorded':datetime.now().astimezone().isoformat(),'environment_overlay':overlay,'source':{rel:{'bytes':len((REPO/rel).read_bytes()),'sha256':hashlib.sha256((REPO/rel).read_bytes()).hexdigest()}for rel in SCOPE}},f,indent=2)
            f.write('\n')
        print('WITNESS',witness,flush=True)
    elif stage == 'repro':
        commands = [[node,'docs/migration/reference/alt-screen-search-index/run.mjs'], [python,'docs/migration/tools/generate_search_case_folding.py'], [python,'docs/migration/tools/verify_alt_screen_search_oracle.py']]
        prior = (LOGS/'2026-09-24-222901-component-screen-widgets-repro.log').read_text('utf8')
        for command in re.findall(r'^COMMAND (.*?) START ',prior,re.M):
            args=command.split();args[0]=node if args[0].lower().endswith(('node.exe', '/node', '\\node')) else python
            commands.append(args)
    elif stage in ('audit','handoff'):
        commands=[[python,'docs/migration/tools/audit_alt_screen_search.py']+(['--handoff']if stage=='handoff'else[])]
    else:
        raise SystemExit('stage must be test/gates/repro/audit/handoff')
    path=LOGS/(datetime.now().strftime('%Y-%m-%d-%H%M%S')+'-alt-screen-search-'+stage+'.log')
    print('LOG',path,flush=True)
    with path.open('xb') as out:
        out.write(('ENVIRONMENT_OVERLAY ' + json.dumps(overlay, sort_keys=True) + '\n').encode())
        out.flush()
        for command in commands:
            header='COMMAND '+' '.join(command)+' START '+datetime.now().astimezone().isoformat()+'\n'
            out.write(header.encode());out.flush();print(header.strip(),flush=True)
            result=subprocess.run(command,cwd=REPO,env=child_env,stdout=out,stderr=subprocess.STDOUT)
            footer='EXIT='+str(result.returncode)+' END '+datetime.now().astimezone().isoformat()+'\n'
            out.write(footer.encode());out.flush();print(footer.strip(),flush=True)
            if result.returncode:
                raise SystemExit(result.returncode)
    print('CLOSED',path,flush=True)
if __name__=='__main__':main()
