#!/usr/bin/env python3
"""Provision synthetic gateways. Keys stay in ignored local secrets/. No credentials are printed."""
import argparse,json,os,pathlib,subprocess,urllib.request
p=argparse.ArgumentParser();p.add_argument('--project',default='bmoas');p.add_argument('--count',type=int,default=20);p.add_argument('--region',default='ap-southeast-2');p.add_argument('--confirm-account',required=True);args=p.parse_args()
def aws(*cmd):
 result=subprocess.run(['aws','--region',args.region,*cmd,'--output','json'],check=True,capture_output=True,text=True)
 return json.loads(result.stdout) if result.stdout.strip() else {}
account=aws('sts','get-caller-identity')['Account']
if account!=args.confirm_account:raise SystemExit('Account confirmation does not match')
if not args.project.isalnum():raise SystemExit('Project must contain only letters and digits')
if not 1<=args.count<=100:raise SystemExit('count must be 1..100')
root=pathlib.Path(__file__).resolve().parents[1];folder=root/'secrets/gateways';folder.mkdir(parents=True,exist_ok=True);os.chmod(folder,0o700)
ca=folder/'AmazonRootCA1.pem'
if not ca.exists():
 with urllib.request.urlopen('https://www.amazontrust.com/repository/AmazonRootCA1.pem',timeout=20) as r:ca.write_bytes(r.read())
config={}
for i in range(1,args.count+1):
 name=f'gateway-{i:03d}';directory=folder/name
 if (directory/'metadata.json').exists():
  meta=json.loads((directory/'metadata.json').read_text())
 else:
  directory.mkdir(exist_ok=True);os.chmod(directory,0o700)
  thing=args.project+'-'+name
  aws('iot','create-thing','--thing-name',thing)
  cert=aws('iot','create-keys-and-certificate','--set-as-active')
  for filename,value in [('certificate.pem',cert['certificatePem']),('private.key',cert['keyPair']['PrivateKey'])]:
   f=directory/filename;f.write_text(value);os.chmod(f,0o600)
  meta={'thing':thing,'certificate_id':cert['certificateId'],'certificate_arn':cert['certificateArn'],'policy':args.project+'-'+name}
  # Record created resources before attaching policies so an interrupted run can be resumed/cleaned up.
  (directory/'metadata.json').write_text(json.dumps(meta,indent=2))
 policy={'Version':'2012-10-17','Statement':[
  {'Effect':'Allow','Action':'iot:Connect','Resource':f'arn:aws:iot:{args.region}:{account}:client/{name}'},
  {'Effect':'Allow','Action':'iot:Publish','Resource':f'arn:aws:iot:{args.region}:{account}:topic/{args.project}/gateways/{name}/observations'}]}
 f=directory/'policy.json';f.write_text(json.dumps(policy));policyname=args.project+'-'+name
 try:aws('iot','create-policy','--policy-name',policyname,'--policy-document','file://'+str(f))
 except subprocess.CalledProcessError:
  existing=aws('iot','get-policy','--policy-name',policyname)
  if json.loads(existing['policyDocument'])!=policy:raise SystemExit(f'Existing policy {policyname} differs. Review it manually.')
 aws('iot','attach-policy','--policy-name',policyname,'--target',meta['certificate_arn'])
 aws('iot','attach-thing-principal','--thing-name',meta['thing'],'--principal',meta['certificate_arn'])
 config[name]={'ca':str(ca),'cert':str(directory/'certificate.pem'),'key':str(directory/'private.key')}
(root/'config/gateways.json').write_text(json.dumps(config,indent=2));os.chmod(root/'config/gateways.json',0o600)
endpoint=aws('iot','describe-endpoint','--endpoint-type','iot:Data-ATS')['endpointAddress']
print(f'Provisioned {args.count} synthetic gateways. MQTT_URL=mqtts://{endpoint}:8883')
print('Set GATEWAY_CONFIG=config/gateways.json locally. Do not upload certificates or private keys to chat or GitHub.')
