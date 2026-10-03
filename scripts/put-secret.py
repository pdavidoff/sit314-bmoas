#!/usr/bin/env python3
"""Create a dedicated plaintext Secrets Manager value, without a secret on the command line."""
import argparse,getpass,json,os,pathlib,secrets,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--name',required=True);p.add_argument('--region',default='ap-southeast-2');p.add_argument('--confirm-account',required=True);p.add_argument('--generate-token',action='store_true');a=p.parse_args()
def aws(*args):return subprocess.run(['aws','--region',a.region,*args,'--output','json'],capture_output=True,text=True,check=True)
account=json.loads(aws('sts','get-caller-identity').stdout)['Account']
if account!=a.confirm_account:raise SystemExit('Account confirmation does not match')
value=secrets.token_urlsafe(32) if a.generate_token else getpass.getpass('Secret value (hidden): ')
if not value:raise SystemExit('Empty secret rejected')
fd,filename=tempfile.mkstemp(prefix='bmoas-secret-');os.chmod(filename,0o600)
try:
 with os.fdopen(fd,'w') as f:f.write(value)
 # Create only. Updating an existing secret is a separate deliberate action.
 result=aws('secretsmanager','create-secret','--name',a.name,'--secret-string','file://'+filename)
 print(json.loads(result.stdout)['ARN'])
finally:
 pathlib.Path(filename).unlink(missing_ok=True)
