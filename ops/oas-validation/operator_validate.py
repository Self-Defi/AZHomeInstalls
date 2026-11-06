#!/usr/bin/env python3
"""Operator validation only. Production calls are hard-coded SELECT/PRAGMA reads.
No production baseline/apply/deploy/send path exists. Future commands are text.
"""
import argparse, datetime, hashlib, json, os, re, shutil, sqlite3, subprocess, sys
from pathlib import Path
import audit
MAIN='a5579c3921dfb4840ffc2753bedc162e45ce6eb7'
DATABASE='azhomeinstalls-leads'
DBID='8cce9a83-ff34-409d-96c7-b33d1cbf134b'
HASHES={
'0001_leads.sql':'8c2fc78e4d33808ea708ab4517cbf55b3eda2606b7be45eda39a35e93cae94dd',
'0002_outbound.sql':'acba7a5e7abe45bb51217251f7cdf17ef2fbf109828cddafabd6af53f6127014',
'0003_outbound_wave_v2.sql':'0060e1757338a1ae6de364443f2f15386ccb0c9d3d65f1e5272ed8b764cee4e5',
'0004_outbound_wave_plan.sql':'c4b175b41acfbd6807f84555e9bca6c9f6320eb0a534b2fccae41c70223aaa88',
'0005_outbound_provider_state.sql':'1ec22d10cf882cab224381a1444cac402de2dcf829f1df3b98ec11076a4288bb',
'0006_outbound_gmail.sql':'455a45d766c05eff538dbd7624dad1d21cc0f207eeda02960e6e802642f6b5cc',
'0007_outbound_reliability.sql':'545d8662b2fbfe4c23e0129cea7d9eaeceae9f17ec966662f86a1bbe5ae2c5c0'}
class Stop(Exception):pass
def need(ok,message):
 if not ok:raise Stop(message)
def load_json(path):
 raw=Path(path).read_bytes();encoding='utf-16' if raw[:2] in (b'\xff\xfe',b'\xfe\xff') else 'utf-8-sig'
 return json.loads(raw.decode(encoding))
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL,text=True,encoding='utf-8').strip()
def rows(value):
 result=[]
 if isinstance(value,list):
  for item in value:result+=rows(item)
 elif isinstance(value,dict):
  if value.get('success') is False or 'error' in value:raise Stop('Read-only Wrangler query failed; verify D1 read permission/account/network access.')
  if 'results' in value:result+=rows(value['results'])
  elif 'result' in value:result+=rows(value['result'])
  else:result.append(value)
 return result
def objects_in_capture(value):
 found=[]
 def visit(v):
  if isinstance(v,list):
   for item in v:visit(item)
  elif isinstance(v,dict):
   if v.get('section')=='objects' and 'payload' in v:
    visit(json.loads(v['payload']) if isinstance(v['payload'],str) else v['payload']);return
   sql=v.get('sql')
   if isinstance(sql,str) and isinstance(v.get('name'),str):
    match=re.match(r'CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\b',sql,re.I)
    if match and not v['name'].startswith('sqlite_'):found.append({'type':v.get('type',match[1].lower()),'name':v['name'],'sql':sql})
   for child in v.values():
    if isinstance(child,(dict,list)):visit(child)
 visit(value);return found
def safe_name(value):return str(value) if re.fullmatch(r'[A-Za-z0-9_ .:-]+',str(value)) else '<nonstandard identifier>'
def schema_gate(expected,actual,label,out):
 diff=audit.comparison(expected,actual);audit.write(out/(label+'-schema-diff.json'),diff)
 bad=[d for d in diff['differences'] if d['classification'] not in ('Exact match','Compatible historical difference')]
 if bad:
  descriptions=[]
  for d in bad:
   obj=d['object'];name=':'.join(obj) if isinstance(obj,(list,tuple)) else obj
   descriptions.append(safe_name(name)+' ['+d['classification']+']')
  raise Stop(label+' schema mismatch: '+ '; '.join(descriptions[:12])+'. Minimum correction: review the named object definitions in the private diff; do not baseline or modify production to force a match.')
 return diff
def find_wrangler():
 node=shutil.which('node.exe') or shutil.which('node');need(node,'Node.js is unavailable; restore the existing Node/Wrangler installation.')
 if os.name=='nt':command=['cmd.exe','/d','/c','npx.cmd','--yes','--package=wrangler@4.158.0','--','where.exe','wrangler']
 else:command=['npx','--yes','--package=wrangler@4.158.0','--','which','wrangler']
 located=subprocess.run(command,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=180)
 need(located.returncode==0,'Cannot locate Wrangler 4.158.0 through the existing npm installation; verify npm registry access.')
 for line in located.stdout.splitlines():
  shim=Path(line.strip());parent=shim.parent
  base=parent.parent if parent.name=='.bin' else parent/'node_modules'
  entry=base/'wrangler/bin/wrangler.js'
  if not entry.is_file():continue
  probe=subprocess.run([node,str(entry),'--version'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
  if probe.returncode==0 and re.search(r'^4\.158\.0\s*$',probe.stdout,re.M):return node,str(entry)
 raise Stop('Wrangler 4.158.0 was not found. Install/cache that version, then rerun; no production changes were made.')
def d1_read(sql,cli,config):
 # SQL is authored here, never taken from the SQL backup or a server response.
 need(not re.search(r'\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|REPLACE|VACUUM|ATTACH|REINDEX)\b',sql,re.I),'Internal read-only guard rejected SQL.')
 proc=subprocess.run([*cli,'d1','execute',DATABASE,'--config',str(config),'--remote','--command='+sql,'--json'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120,env={**os.environ,'WRANGLER_SEND_METRICS':'false'})
 if proc.returncode:
  codes=re.findall(r'\bcode[:=\s]+([0-9]{4,7})\b',proc.stdout+proc.stderr,re.I)
  raise Stop('Read-only D1 request failed (exit '+str(proc.returncode)+('; API code '+','.join(sorted(set(codes))) if codes else '')+'). Minimum correction: verify existing Wrangler account, D1 read permissions and network access. No write was attempted.')
 try:data=json.loads(proc.stdout)
 except json.JSONDecodeError:raise Stop('Wrangler did not return valid JSON. Check its local installation/output; no production write was attempted.')
 rows(data);return data

def future_commands(out,repo,cli,live,history):
 q=lambda value:"'"+str(value).replace("'","''")+"'"
 config=repo/'cloudflare/wrangler.jsonc';prefix='& '+q(cli[0])+' '+q(cli[1]);common=' --config '+q(config)
 base=(Path(__file__).parent/'baseline-history.proposed.sql').read_text();(out/'baseline-history.proposed.sql').write_text(base,encoding='utf-8')
 names=list(HASHES)
 expected='WITH expected(id,name) AS (VALUES '+','.join('('+str(i)+",'"+name+"')" for i,name in enumerate(names,1))+') '
 def checkpoint(n):
  return expected+"SELECT CASE WHEN (SELECT COUNT(*) FROM d1_migrations)="+str(n)+" AND NOT EXISTS(SELECT 1 FROM d1_migrations h WHERE h.id<1 OR h.id>"+str(n)+") AND NOT EXISTS(SELECT 1 FROM d1_migrations h LEFT JOIN expected e ON e.id=h.id WHERE e.id IS NULL OR h.name IS NOT e.name OR h.applied_at IS NULL) AND COALESCE((SELECT paused=1 AND daily_cap=5 FROM outbound_settings WHERE id=1),0)=1 THEN 'PASS: history and paused cap verified' ELSE json_extract('STOP: checkpoint failed','$') END AS checkpoint;"
 (out/'baseline-check.sql').write_text(checkpoint(6),encoding='utf-8')
 count_checks=' AND '.join('(SELECT COUNT(*) FROM '+t+')='+str(n) for t,n in live.items())
 post=checkpoint(7)+" SELECT CASE WHEN "+count_checks+" AND (SELECT COUNT(*) FROM pragma_table_xinfo('outbound_prospects_v2') WHERE name IN ('validation_status','validation_checked_at','validation_expires_at','validation_note','validated_source_url','research_only'))=6 AND (SELECT COUNT(*) FROM pragma_table_xinfo('outbound_settings') WHERE name IN ('pipeline_lease','pipeline_lease_until'))=2 AND (SELECT COUNT(*) FROM sqlite_master WHERE name IN ('outbound_introduction_reservations','outbound_introduction_reservations_day','outbound_validation_backlog'))=3 AND (SELECT COUNT(*) FROM pragma_foreign_key_check)=0 THEN 'PASS: schema, counts and FK checkpoint' ELSE json_extract('STOP: post-migration mismatch','$') END AS checkpoint; PRAGMA quick_check;"
 post+=" WITH expected AS (SELECT id message_id,COALESCE(date(claimed_until,'-10 minutes','-7 hours'),date('now','-7 hours')) phoenix_date,'legacy-uncertain' owner FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NULL AND (status='claimed' OR last_error LIKE '%uncertain%')) SELECT CASE WHEN NOT EXISTS(SELECT message_id,phoenix_date,owner FROM expected EXCEPT SELECT message_id,phoenix_date,owner FROM outbound_introduction_reservations) AND NOT EXISTS(SELECT message_id,phoenix_date,owner FROM outbound_introduction_reservations EXCEPT SELECT message_id,phoenix_date,owner FROM expected) THEN 'PASS: reservation backfill' ELSE json_extract('STOP: backfill mismatch; preserve all reservations','$') END AS checkpoint;"
 (out/'migration-check.sql').write_text(post,encoding='utf-8')
 read=lambda file:prefix+' d1 execute '+DATABASE+common+' --remote ("--command=" + [IO.File]::ReadAllText('+q(out/file)+')) --json'
 list_deploy=prefix+' deployments list'+common+' --name azhomeinstalls-estimate --json'
 text='''# PROPOSED COMMANDS ONLY. This file is never executed by validation.
# Run one stage at a time after separate write authorization. Stop on any error.
# Keep existing sending/enrollment pauses. No test-send or campaign restart.
# Confirm correct Cloudflare account, recovery point and no concurrent migration operator.
# Do not cross Arizona midnight; postflight fallback-day comparisons use the execution day.
# If counts change due to legitimate business activity, investigate; never reset data.
'''
 text+='Set-Location '+q(repo/'cloudflare')+'\n'
 text+="if ((git rev-parse HEAD).Trim() -ne '"+MAIN+"') { throw 'STOP: source commit changed' }\ngit diff --quiet HEAD -- .\nif ($LASTEXITCODE -ne 0) { throw 'STOP: reviewed source files have local changes' }\n"
 text+='\n# WRITE 1: historical metadata baseline only (idempotent for a verified prefix).\n'+read('baseline-history.proposed.sql')+'\n# CHECKPOINT 1: require PASS; then verify ONLY 0007 is pending.\n'+read('baseline-check.sql')+'\n'
 text+=prefix+' d1 migrations list '+DATABASE+common+' --remote\n'
 text+='\n# WRITE 2: proceed ONLY if the list contains 0007 and no other filename.\n'
 text+=prefix+' d1 migrations apply '+DATABASE+common+' --remote\n# CHECKPOINT 2: require PASS results, quick_check=ok, and no pending migrations.\n'+read('migration-check.sql')+'\n'
 text+=prefix+' d1 migrations list '+DATABASE+common+' --remote\n'
 text+='\n# Independent full-schema verification after WRITE 2 (read-only):\n& '+q(sys.executable)+' -X utf8 '+q(Path(__file__).resolve())+' --postcheck --repo '+q(repo)+' --out '+q(out)+'\n'
 text+='''
# Before WRITE 3, record current Worker version and secret-binding NAMES only.
$beforeDeployment = @('''+list_deploy+''' | ConvertFrom-Json) | Sort-Object created_on | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or @($beforeDeployment.versions).Count -ne 1) { throw 'STOP: cannot establish active Worker' }
$beforeId = $beforeDeployment.versions[0].version_id
$beforeVersion = '''+prefix+''' versions view $beforeId'''+common+''' --name azhomeinstalls-estimate --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'STOP: cannot inspect existing bindings' }
$oldSecrets = @($beforeVersion.resources.bindings | Where-Object type -eq 'secret_text' | ForEach-Object name)
# Verify campaign remains paused immediately before deployment.
'''+read('baseline-check.sql').replace('baseline-check.sql','migration-check.sql')+'\n'
 text+='\n# WRITE 3: deploy the reviewed Worker with enrollment explicitly OFF.\n'
 text+=prefix+" deploy"+common+" --no-autoconfig --keep-vars --var 'OUTBOUND_AUTO_ENROLL_WAVE1:false' --var 'OUTBOUND_NEW_DAILY_CAP:5' --tag 'oas-reliability-a5579c3'\n"
 text+='''
# CHECKPOINT 3: active version, public-only fetch, enrollment off, cap, D1 and secret names.
$active = @('''+list_deploy+''' | ConvertFrom-Json) | Sort-Object created_on | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or @($active.versions).Count -ne 1 -or $active.versions[0].percentage -ne 100) { throw 'STOP: unexpected traffic split' }
$versionId = $active.versions[0].version_id
$v = '''+prefix+''' versions view $versionId'''+common+''' --name azhomeinstalls-estimate --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'STOP: cannot verify deployed version' }
$b = @($v.resources.bindings)
if ($v.annotations.'workers/tag' -ne 'oas-reliability-a5579c3') { throw 'STOP: wrong deployed tag' }
if ($v.resources.script_runtime.compatibility_flags -notcontains 'global_fetch_strictly_public') { throw 'STOP: missing public-only fetch flag' }
if (@($b | Where-Object { $_.name -eq 'OUTBOUND_AUTO_ENROLL_WAVE1' -and $_.text -eq 'false' }).Count -ne 1) { throw 'STOP: enrollment not disabled' }
if (@($b | Where-Object { $_.name -eq 'OUTBOUND_NEW_DAILY_CAP' -and $_.text -eq '5' }).Count -ne 1) { throw 'STOP: wrong introduction cap' }
if (@($b | Where-Object { $_.name -eq 'LEADS_DB' -and $_.id -eq '''+q(DBID)+''' }).Count -ne 1) { throw 'STOP: wrong D1 binding' }
$newSecrets = @($b | Where-Object type -eq 'secret_text' | ForEach-Object name)
if (@($oldSecrets | Where-Object { $_ -notin $newSecrets }).Count -ne 0) { throw 'STOP: a prior secret binding is missing' }
'''+read('migration-check.sql')+'''
$r = Invoke-WebRequest -UseBasicParsing -Method Options -Uri 'https://azhomeinstalls.com/api/estimate'
if ($r.StatusCode -ne 204) { throw 'STOP: Worker route health failed' }
Write-Output ('PASS: Worker deployment checkpoints; active version ' + $versionId + '; outreach remains paused.')
# Do not restart outreach. Verify authenticated admin operations using existing
# operator access. This Worker command does not publish static dashboard assets.
'''
 (out/'NEXT-STEPS.txt').write_text(text,encoding='utf-8');return text

def main():
 p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--schema',type=Path,required=True);p.add_argument('--backup',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
 repo=a.repo.resolve();out=a.out.resolve();need(not out.exists(),'Use a fresh output directory to avoid stale PASS results.');out.mkdir(parents=True)
 audit.ROOT=repo;audit.MIGRATIONS=repo/'cloudflare/migrations'
 need(a.schema.is_file(),'Captured schema file not found. Set SchemaPath to its actual local path.');need(a.backup.is_file(),'SQL backup not found. Set BackupPath to its actual local path.')
 need(hashlib.sha256(a.backup.read_bytes()).hexdigest()==audit.BACKUP_SHA,'Backup SHA-256 mismatch. Use the unchanged operator-verified backup; do not edit the expected checksum.')
 print('PASS: verified backup SHA-256',flush=True)
 need(git(repo,'rev-parse','HEAD')==MAIN,'Repository is not at reviewed main '+MAIN+'. Use a clean reviewed checkout; do not reset or overwrite local work.')
 need(subprocess.run(['git','-C',str(repo),'diff','--quiet','HEAD','--','cloudflare'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0,'Tracked Cloudflare files differ from the reviewed commit. Preserve/review local edits before retrying.')
 need({path.name for path in audit.MIGRATIONS.glob('*.sql')}==set(HASHES),'Migration directory has missing/extra SQL files. Review before proceeding.')
 for name,checksum in HASHES.items():need(hashlib.sha256((audit.MIGRATIONS/name).read_text(encoding='utf-8').encode()).hexdigest()==checksum,'Reviewed migration contents differ: '+name)
 config=repo/'cloudflare/wrangler.jsonc';c=json.loads(config.read_text(encoding='utf-8'))
 need(c['name']=='azhomeinstalls-estimate' and len(c['d1_databases'])==1 and c['d1_databases'][0]['database_id']==DBID and c['d1_databases'][0]['database_name']==DATABASE,'Worker/D1 configuration does not match the reviewed production target.')
 need(c['vars']['OUTBOUND_AUTO_ENROLL_WAVE1']=='false' and c['vars']['OUTBOUND_NEW_DAILY_CAP']=='5' and 'global_fetch_strictly_public' in c['compatibility_flags'],'Reviewed pause/cap/public-fetch configuration changed.')
 expected=audit.snapshot(audit.expected_databases(out));provided=load_json(a.schema)
 normalized=out/'input-schema.json';audit.write(normalized,provided)
 try:actual=audit.load_capture(normalized)
 except ValueError:actual=None
 cli=None
 if actual is None:
  cli=find_wrangler();fresh=d1_read(audit.SCHEMA_SQL,cli,config);audit.write(out/'production-schema.json',fresh);actual=audit.load_capture(out/'production-schema.json')
  live_objects={(x['type'],x['name']):x for x in actual['objects']}
  for original in objects_in_capture(provided):
   current=live_objects.get((original['type'],original['name']))
   need(current is not None and audit.norm_sql(current['sql'])==audit.norm_sql(original['sql']),'Schema capture drift: '+safe_name(original['name'])+'. Reconcile the captured and current object definitions before continuing.')
  print('PASS: missing metadata supplemented with read-only production queries',flush=True)
 schema_gate(expected,actual,'production',out);print('PASS: full production schema comparison (0001-0006)',flush=True)
 if cli is None:cli=find_wrangler()
 counts_sql=','.join("'"+table+"',(SELECT COUNT(*) FROM "+table+')' for table in audit.KNOWN_COUNTS)
 state_sql="SELECT 'state' section,json_object('paused',(SELECT paused FROM outbound_settings WHERE id=1),'cap',(SELECT daily_cap FROM outbound_settings WHERE id=1),'history',(SELECT json_group_array(json_object('id',id,'name',name)) FROM (SELECT id,name FROM d1_migrations ORDER BY id)),'counts',json_object("+counts_sql+")) payload; PRAGMA quick_check; SELECT COUNT(*) AS fk_violations FROM pragma_foreign_key_check;"
 state_response=d1_read(state_sql,cli,config);audit.write(out/'production-state.json',state_response);state_rows=rows(state_response)
 state=json.loads(next(r['payload'] for r in state_rows if r.get('section')=='state'))
 need(state['paused']==1 and state['cap']==5,'Live OAS is not paused at cap five. Use authorized operator controls in a separate task; this validator will not modify it.')
 need(any(r.get('quick_check')=='ok' for r in state_rows) and not any(r.get('quick_check','ok')!='ok' for r in state_rows),'Production quick_check did not pass. Stop and investigate integrity without data repair.')
 need(any(r.get('fk_violations')==0 for r in state_rows),'Production foreign-key violations detected. Stop for targeted investigation.')
 history=state['history'];need(len(history)<=6 and all(r['id']==i and r['name']==name for i,(r,name) in enumerate(zip(history,list(HASHES)),1)),'Unexpected production migration history. Review exact filenames/order; do not rerun old migrations.')
 live=state['counts'];changed=[table for table,n in audit.KNOWN_COUNTS.items() if live.get(table)!=n]
 need(not changed,'Live counts differ from the verified backup: '+', '.join(t+'='+str(live.get(t))+' (backup '+str(audit.KNOWN_COUNTS[t])+')' for t in changed)+'. Review legitimate intervening activity and recovery freshness before writes; do not reset data or change the backup checksum.')
 print('PASS: live pause, cap, history, counts, quick_check and foreign keys',flush=True)
 restored=out/'restored-backup.sqlite';db=sqlite3.connect(restored)
 def authorizer(action,a,b,*rest):return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH) or action==sqlite3.SQLITE_FUNCTION and (b or '').lower()=='load_extension' else sqlite3.SQLITE_OK
 db.set_authorizer(authorizer);db.executescript(a.backup.read_text(encoding='utf-8-sig'));db.set_authorizer(None);db.execute('PRAGMA foreign_keys=ON')
 need(db.execute('PRAGMA integrity_check').fetchall()==[('ok',)],'Backup integrity_check failed. Preserve the backup; obtain an independently verified recoverable export.')
 need(db.execute('SELECT COUNT(*) FROM pragma_foreign_key_check').fetchone()[0]==0,'Backup has foreign-key violations. Investigate before migration rehearsal.')
 schema_gate(expected,audit.snapshot(db),'backup',out)
 need(all(audit.counts(db).get(t)==n for t,n in audit.KNOWN_COUNTS.items()),'Backup record counts do not match its verified manifest. Stop and review provenance.')
 need(db.execute('SELECT COUNT(*) FROM d1_migrations').fetchone()[0]==0,'Backup migration history is not empty as expected. Review the appropriate baseline instead of overwriting history.')
 need(db.execute('SELECT paused,daily_cap FROM outbound_settings WHERE id=1').fetchone()==(1,5),'Backup settings differ from the paused cap-five baseline. Review before changing anything.')
 db.executescript((Path(__file__).parent/'baseline-history.proposed.sql').read_text(encoding='utf-8'))
 need([r[0] for r in db.execute('SELECT name FROM d1_migrations ORDER BY id')]==list(HASHES)[:6],'Local historical baseline failed verification.')
 result=audit.offline_migration_test(db,out)
 need(result['passed'] and result['migration_tracking']==list(HASHES),'Offline migration 0007 or tracking validation failed.')
 need(db.execute("SELECT COUNT(*) FROM outbound_prospects_v2 WHERE validation_status<>'pending' OR research_only<>0 OR validation_expires_at IS NOT NULL").fetchone()[0]==0,'New verification fields do not have conservative defaults.')
 need(db.execute("SELECT COUNT(*) FROM outbound_introduction_reservations r JOIN outbound_messages_v2 m ON m.id=r.message_id WHERE m.claimed_until IS NOT NULL AND r.reserved_at IS NOT m.claimed_until").fetchone()[0]==0,'Historical reservation timestamp preservation failed.')
 print('PASS: verified-backup restore and migration 0007 rehearsal',flush=True)
 print('PASS: full integrity, FK consistency, original rows/counts/sequences, reservation backfill and migration tracking',flush=True)
 audit.write(out/'tool-context.json',{'cli':list(cli),'main':MAIN})
 commands=future_commands(out,repo,cli,live,history)
 summary={'schema_comparison':'PASS','backup_sha256':'PASS','offline_0007_rehearsal':'PASS','original_records_preserved':True,'reservation_backfill_count':result['backfill_actual'],'fallback_day_candidates':result['fallback_day_candidates'],'production_writes_executed':False,'worker_deployed':False,'outreach_restart_executed':False,'decision':'PASS validations; production commands are proposals requiring separate approval'}
 audit.write(out/'SANITIZED-REPORT.json',summary);print('BEGIN SANITIZED REPORT',flush=True);print(json.dumps(summary,indent=2),flush=True);print('END SANITIZED REPORT',flush=True)
 print('\nPROPOSED NEXT COMMANDS ONLY - NOT EXECUTED\n'+commands,flush=True)

def postcheck():
 p=argparse.ArgumentParser();p.add_argument('--postcheck',action='store_true');p.add_argument('--repo',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
 audit.ROOT=a.repo.resolve();audit.MIGRATIONS=audit.ROOT/'cloudflare/migrations'
 need(git(audit.ROOT,'rev-parse','HEAD')==MAIN,'Source changed after validation; stop and review.')
 cli=tuple(load_json(a.out/'tool-context.json')['cli']);config=audit.ROOT/'cloudflare/wrangler.jsonc'
 captured=d1_read(audit.SCHEMA_SQL,cli,config);audit.write(a.out/'post-migration-schema.json',captured)
 expected=load_json(a.out/'schema-after-0007.json');actual=audit.load_capture(a.out/'post-migration-schema.json')
 schema_gate(expected,actual,'post-migration',a.out)
 checks=d1_read((a.out/'migration-check.sql').read_text(encoding='utf-8'),cli,config)
 audit.write(a.out/'post-migration-checkpoints.json',checks)
 results=rows(checks)
 need(any(r.get('quick_check')=='ok' for r in results),'Post-migration quick_check failed.')
 print('PASS: full post-0007 schema, history, paused cap, counts, foreign keys, quick_check and reservation backfill verified; no writes performed.')

if __name__=='__main__':
 try:postcheck() if '--postcheck' in sys.argv else main()
 except Stop as error:print('FAIL: '+str(error));sys.exit(1)
 except sqlite3.Error as error:print('FAIL: isolated backup/migration SQL failed ['+getattr(error,'sqlite_errorname',type(error).__name__)+']. No production write occurred. Minimum correction: investigate the backup/schema compatibility; do not paste customer SQL.');sys.exit(1)
 except (json.JSONDecodeError,UnicodeError):print('FAIL: input/captured JSON encoding or syntax is invalid. Recapture valid UTF-8/UTF-16 JSON; no production write occurred.');sys.exit(1)
 except Exception as error:print('FAIL: validation stopped ['+type(error).__name__+']. No production writes occurred. Check local Python, file access and tooling; preserve all evidence.');sys.exit(1)
