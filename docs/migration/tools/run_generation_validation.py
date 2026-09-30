"""Serial, offline generation validation. Exclusive logs; child-only loopback bypass."""
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LOGS = REPO / 'docs/migration/validation'

def main():
    stage = sys.argv[1]
    if stage == 'targeted':
        commands = [['cargo','test','--offline','--lib',name] for name in ['generation::tests','request_callbacks','runtime::progress::progress_channel_tests','response::lifecycle_tests','execution::assistant::tests']]
    elif stage == 'gates':
        commands = [['cargo','fmt','--all','--','--check'],['cargo','clippy','--offline','--all-targets','--','-D','warnings'],['cargo','test','--offline','--all-targets'],['cargo','test','--offline','--doc']]
    elif stage == 'repro':
        commands = [[os.environ.get('NODE','node'),'docs/migration/reference/generation/oracle.mjs','--check']]
    else:
        raise SystemExit('Use targeted, gates, or repro')
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    scope = json.loads((REPO/'docs/migration/generation-scope.json').read_text(encoding='utf8'))
    witness = {'recordedAt':datetime.now().astimezone().isoformat(),'stage':stage,'sha256':{path:hashlib.sha256((REPO/path).read_bytes()).hexdigest() for path in scope}}
    with (LOGS/f'generation-{stage}-source-{stamp}.json').open('x',encoding='utf8') as output:
        json.dump(witness,output,indent=2)
        output.write('\n')
    child = dict(os.environ)
    child['NO_PROXY'] = 'localhost,127.0.0.1,::1'
    path = LOGS/f'generation-{stage}-{stamp}.log'
    print('LOG',path,flush=True)
    with path.open('xb') as output:
        output.write(b'CHILD_ENVIRONMENT_OVERLAY NO_PROXY=localhost,127.0.0.1,::1; parent unchanged\n')
        for command in commands:
            header = 'COMMAND '+json.dumps(command)+' START '+datetime.now().astimezone().isoformat()+'\n'
            output.write(header.encode());output.flush();print(header.strip(),flush=True)
            result = subprocess.run(command,cwd=REPO,env=child,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            output.write(result.stdout)
            if stage == 'targeted' and result.returncode == 0 and not re.search(rb'(?m)^running [1-9][0-9]* tests?\r?$', result.stdout):
                output.write(b'ERROR: targeted filter matched zero tests\n')
                result.returncode = 2
            footer = 'EXIT='+str(result.returncode)+' END '+datetime.now().astimezone().isoformat()+'\n'
            output.write(footer.encode());output.flush();print(footer.strip(),flush=True)
            if result.returncode: raise SystemExit(result.returncode)
    print('CLOSED',path,flush=True)

if __name__=='__main__':main()
