#!/usr/bin/env python3
"""Use existing evidence only: no Cloudflare client, HTTP call or backup rehash.
Captured sqlite_master DDL is reconstructed in memory; only the local backup
copy is migrated. Existing audit/backup-preservation implementation is reused.
"""
import argparse,json,re,sqlite3,subprocess,sys
from pathlib import Path
import audit
import operator_validate as shared

CAPTURE="npx.cmd --yes wrangler@4.158.0 d1 execute azhomeinstalls-leads --config .\\wrangler.jsonc --remote --command=\"SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name;\" --json | Set-Content -Encoding UTF8 .\\ahi-production-schema-complete.json"
class Incomplete(shared.Stop):pass

def catalog_from_json(value):
 found={};automatic={};missing=[]
 def visit(v):
  if isinstance(v,list):
   for item in v:visit(item)
  elif isinstance(v,dict):
   if v.get('success') is False or 'error' in v:raise Incomplete('Capture contains an error result, not a complete schema catalog.')
   if v.get('section')=='objects' and 'payload' in v:
    visit(json.loads(v['payload']) if isinstance(v['payload'],str) else v['payload']);return
   if isinstance(v.get('name'),str) and 'sql' in v:
    name=v['name'];sql=v['sql'];kind=v.get('type')
    if name.startswith('sqlite_autoindex_'):
     automatic[name]=v.get('tbl_name',v.get('table'));return
    if name.startswith('sqlite_'):return
    if not isinstance(sql,str) or not sql.strip():missing.append(name);return
    match=re.match(r'^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\b',sql,re.I)
    if not match:raise shared.Stop('Unsupported captured DDL for '+shared.safe_name(name)+'. Review that object; no SQL was run against production.')
    declared=match[1].lower()
    if kind is not None and str(kind).lower()!=declared:raise Incomplete('Inconsistent catalog type for '+shared.safe_name(name))
    key=(declared,name)
    if key in found and audit.norm_sql(found[key]['sql'])!=audit.norm_sql(sql):raise Incomplete('Conflicting captured definitions for '+shared.safe_name(name))
    found[key]={'type':declared,'name':name,'sql':sql,'table':v.get('tbl_name',v.get('table'))}
   for child in v.values():
    if isinstance(child,(dict,list)):visit(child)
 visit(value)
 if missing:raise Incomplete('Missing SQL definitions: '+', '.join(map(shared.safe_name,missing)))
 if not found:raise Incomplete('No per-object sqlite_master name/sql definitions were found in this JSON.')
 return list(found.values()),automatic

def reconstruct_catalog(value,expected,out):
 objects,automatic=catalog_from_json(value)
 actual_keys={(r['type'],r['name']) for r in objects}
 missing=[r['type']+':'+r['name'] for r in expected['objects'] if (r['type'],r['name']) not in actual_keys]
 if ('table','d1_migrations') not in actual_keys:missing.append('table:d1_migrations')
 if missing:raise Incomplete('Required catalog entries absent (filtered capture or missing production objects): '+', '.join(map(shared.safe_name,missing)))
 shadow=sqlite3.connect(':memory:')
 def restrict(action,a,b,*rest):
  return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH) or action==sqlite3.SQLITE_FUNCTION and (b or '').lower()=='load_extension' else sqlite3.SQLITE_OK
 shadow.set_authorizer(restrict)
 for kind in ['table','index','view','trigger']:
  for row in objects:
   if row['type']!=kind:continue
   try:shadow.execute(row['sql'])  # One DDL statement, no data/backup contents.
   except sqlite3.Error as error:raise shared.Stop('Cannot reconstruct captured '+kind+':'+shared.safe_name(row['name'])+' ['+getattr(error,'sqlite_errorname','SQLITE_ERROR')+']. Review its definition; no automatic remediation.')
 actual=audit.snapshot(shadow)
 # The captured SQL, rather than SQLite's rewritten spelling, is authoritative.
 by_key={(row['type'],row['name']):row for row in objects}
 for row in actual['objects']:
  if (row['type'],row['name']) in by_key:row['sql']=by_key[(row['type'],row['name'])]['sql']
 for name,table in automatic.items():
  generated=shadow.execute("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?",(name,)).fetchone()
  if not generated or table is not None and generated[0]!=table:raise Incomplete('Automatic index cannot be reconciled with captured table constraints: '+shared.safe_name(name))
 # Reproduction of CREATE TABLE/INDEX preserves CHECK/UNIQUE/PK/FK/defaults,
 # generated columns, WITHOUT ROWID/STRICT, expressions and declared collations.
 # PRAGMAs here inspect the local shadow, never the remote production database.
 audit.write(out/'captured-schema-derived-metadata.json',actual)
 return actual

def main():
 p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--schema',type=Path,required=True);p.add_argument('--backup',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--resume-from',type=Path)
 p.add_argument('--accept-prior-sha256-pass',required=True);a=p.parse_args()
 shared.need(a.accept_prior_sha256_pass==audit.BACKUP_SHA,'Prior checksum attestation does not match the verified backup SHA-256.')
 shared.need(a.schema.is_file(),'Captured schema file not found; set its correct local path.')
 shared.need(a.backup.is_file(),'Previously verified backup file not found; set the path to that same unchanged file.')
 repo=a.repo.resolve();out=a.out.resolve();shared.need(not out.exists(),'Use a fresh output directory.');out.mkdir(parents=True)
 audit.ROOT=repo;audit.MIGRATIONS=repo/'cloudflare/migrations'
 shared.need(shared.git(repo,'rev-parse','HEAD')==shared.MAIN,'Checkout differs from reviewed main '+shared.MAIN+'. Use the reviewed source without overwriting local work.')
 shared.need(subprocess.run(['git','-C',str(repo),'diff','--quiet','HEAD','--','cloudflare/migrations','cloudflare/estimate-worker.js'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0,'Reviewed migration or runtime-schema source files have local changes; preserve and review them.')
 shared.need({p.name for p in audit.MIGRATIONS.glob('*.sql')}==set(shared.HASHES),'Migration directory does not contain exactly the seven reviewed SQL files.')
 expected=audit.snapshot(audit.expected_databases(out))
 provided=shared.load_json(a.schema)
 # Prefer already supplied full metadata; otherwise derive it faithfully from DDL.
 normalized=out/'captured-input.json';audit.write(normalized,provided)
 try:actual=audit.load_capture(normalized);method='supplied structural metadata'
 except ValueError:actual=reconstruct_catalog(provided,expected,out);method='derived locally from captured sqlite_master DDL'
 if a.resume_from:
  prior=a.resume_from.resolve()
  shared.need(shared.load_json(prior/'captured-input.json')==provided,'Resume capture differs from previously passed evidence.')
  prior_diff=shared.load_json(prior/'captured-production-schema-diff.json')
  shared.need(prior_diff.get('schema_gate') is True,'Previous captured-production comparison did not pass; cannot resume.')
  audit.write(out/'captured-production-schema-diff.json',prior_diff)
  print('PASS: captured-production application comparison reused from previous successful run; unchanged capture.',flush=True)
 else:
  shared.schema_gate(expected,actual,'captured-production',out)
  print('PASS: captured production schema matches migrations 0001-0006; structural metadata '+method,flush=True)
 print('CHECKSUM: prior operator-confirmed PASS accepted; backup SHA-256 was NOT recomputed.',flush=True)
 restored=out/'restored-backup.sqlite';db=sqlite3.connect(restored)
 def restrict(action,a,b,*rest):return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH) or action==sqlite3.SQLITE_FUNCTION and (b or '').lower()=='load_extension' else sqlite3.SQLITE_OK
 db.set_authorizer(restrict);db.executescript(a.backup.read_text(encoding='utf-8-sig'));db.set_authorizer(None);db.execute('PRAGMA foreign_keys=ON')
 shared.need(db.execute('PRAGMA integrity_check').fetchall()==[('ok',)],'Backup integrity_check failed. Preserve the file and investigate a verified recoverable backup.')
 violations=db.execute('SELECT COUNT(*) FROM pragma_foreign_key_check').fetchone()[0]
 shared.need(violations==0,'Backup foreign-key violations: '+str(violations)+'. Review references; do not repair or delete production records.')
 backup_schema=audit.snapshot(db)
 audit.write(out/'backup-schema-as-exported.json',backup_schema)
 tracking_reconstructed=False
 if not db.execute("SELECT 1 FROM sqlite_master WHERE lower(name)='d1_migrations'").fetchone():
  tracking=[r for r in actual['objects'] if (r['type'],r['name'])==('table','d1_migrations')]
  shared.need(len(tracking)==1,'Cannot reconstruct metadata: validated captured d1_migrations table is missing.')
  # No application object/data is changed; only a missing metadata table in
  # this new isolated SQLite copy is created from the validated live DDL.
  db.execute(tracking[0]['sql'])
  for row in actual['objects']:
   if row['type']=='index' and row.get('table')=='d1_migrations':db.execute(row['sql'])
  db.commit();tracking_reconstructed=True
  print('CONFIRMED: restored SQL export omits d1_migrations. Reconstructed only that empty tracking table in the isolated rehearsal database.',flush=True)
  backup_schema=audit.snapshot(db)
 shared.schema_gate(expected,backup_schema,'backup-historical',out)
 shared.schema_gate(actual,backup_schema,'backup-versus-capture',out)
 print('PASS: actual backup application schema matches migrations 0001-0006 and the captured production application schema.',flush=True)
 counts=audit.counts(db);changed=[t for t,n in audit.KNOWN_COUNTS.items() if counts.get(t)!=n]
 shared.need(not changed,'Verified-backup count manifest differs for: '+', '.join(map(shared.safe_name,changed))+'. Review provenance; do not change data to force a match.')
 shared.need(db.execute('SELECT COUNT(*) FROM d1_migrations').fetchone()[0]==0,'Backup history is not empty as previously reported; review the historical baseline plan.')
 shared.need(db.execute('SELECT paused,daily_cap FROM outbound_settings WHERE id=1').fetchone()==(1,5),'Backup settings are not the reported paused/cap-five baseline. Review this difference before rehearsal.')
 db.executescript((Path(__file__).parent/'baseline-history.proposed.sql').read_text(encoding='utf-8'))
 shared.need([r[0] for r in db.execute('SELECT name FROM d1_migrations ORDER BY id')]==list(shared.HASHES)[:6],'Local-only historical baseline did not produce the six exact filenames.')
 result=audit.offline_migration_test(db,out)
 shared.need(result['passed'] and result['migration_tracking']==list(shared.HASHES),'Offline migration 0007 compatibility/preservation/backfill check failed.')
 shared.need(db.execute("SELECT COUNT(*) FROM outbound_prospects_v2 WHERE validation_status<>'pending' OR research_only<>0 OR validation_expires_at IS NOT NULL").fetchone()[0]==0,'Unexpected verification defaults after the local rehearsal.')
 shared.need(db.execute("SELECT COUNT(*) FROM outbound_introduction_reservations r JOIN outbound_messages_v2 m ON m.id=r.message_id WHERE m.claimed_until IS NOT NULL AND r.reserved_at IS NOT m.claimed_until").fetchone()[0]==0,'Historical reservation timestamp preservation failed in the local copy.')
 summary={'overall':'PASS: captured-schema comparison and actual-backup offline rehearsal','schema_metadata':method,'backup_sha256':'PRIOR PASS accepted; not recomputed','application_schema':'PASS','tracking_table_reconstructed_locally':tracking_reconstructed,'original_backup_modified':False,'offline_migration_0007':'PASS','integrity_check':'PASS','foreign_key_violations':0,'all_original_business_records_and_sequences_preserved':True,'backfilled_reservations':result['backfill_actual'],'fallback_day_candidates':result['fallback_day_candidates'],'production_api_requests':0,'production_writes':0,'deployments':0,'gmail_sends':0,'live_production_state':'Not rechecked; captured evidence only','production_execution_authorized':False}
 audit.write(out/'SANITIZED-REPORT.json',summary)
 print('BEGIN SANITIZED REPORT\n'+json.dumps(summary,indent=2)+'\nEND SANITIZED REPORT')
 print('PROPOSED PRODUCTION COMMANDS ONLY; NOT EXECUTED. Live production pause, backup freshness and account must be reconfirmed before any write.')
 print(shared.future_commands(out,repo,['npx.cmd','wrangler@4.158.0'],audit.KNOWN_COUNTS,[]))

if __name__=='__main__':
 try:main()
 except Incomplete as error:
  print('FAIL: capture completeness cannot be established. '+str(error))
  print('Missing evidence: complete CREATE definitions for every application table and named index, and the catalog of views/triggers. No live PRAGMA access is needed when those definitions are complete.')
  print('ONE CONSOLIDATED READ-ONLY CAPTURE COMMAND, only if the existing catalog is incomplete:\n'+CAPTURE)
  sys.exit(1)
 except shared.Stop as error:print('FAIL: '+str(error));sys.exit(1)
 except sqlite3.Error as error:print('FAIL: offline SQLite check ['+getattr(error,'sqlite_errorname','SQLITE_ERROR')+']. Inspect the private local schema diff/backup provenance. No production request or write occurred.');sys.exit(1)
 except (json.JSONDecodeError,UnicodeError):print('FAIL: captured JSON is not valid UTF-8/UTF-16 JSON. Use the original successful Wrangler JSON output; no API request was repeated.');sys.exit(1)
 except Exception as error:print('FAIL: offline validation stopped ['+type(error).__name__+']. Preserve local evidence; no production API call was made.');sys.exit(1)
