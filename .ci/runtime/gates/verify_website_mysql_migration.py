#!/usr/bin/env python3
"""Exercise website migration 32 on disposable, network-isolated real MySQL.

Never accepts an existing database/container. Requires an explicit local Docker
context; creates and removes only its own uniquely named fixture container.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--image', default='mysql:8.0')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    docker = ['docker', '--context', args.docker_context]
    def cli(*parts, input=None, check=True):
        result = subprocess.run(docker + list(parts), input=input, text=True, capture_output=True, timeout=240)
        if check and result.returncode:
            raise RuntimeError(f'Docker fixture command {parts[0]} failed: {result.stderr[:300]}')
        return result
    context = json.loads(cli('context', 'inspect', args.docker_context).stdout)[0]
    if not context['Endpoints']['docker']['Host'].startswith('unix://'):
        raise ValueError('only explicitly selected local Unix Docker contexts are allowed')
    cli('pull', args.image)
    image = json.loads(cli('image', 'inspect', args.image).stdout)[0]
    name = 'website-mysql-verify-' + uuid.uuid4().hex[:12]
    report = {'image_id': image['Id'], 'repo_digests': image.get('RepoDigests', []), 'checks': []}
    created = False
    def sql(text):
        return cli('exec', '-i', name, 'mysql', '--batch', '--skip-column-names', '-uroot', 'website_test', input=text).stdout.strip()
    def check(label, condition):
        if not condition:
            raise AssertionError(label)
        report['checks'].append(label)
    try:
        cli('run', '-d', '--name', name, '--label', 'purpose=website-migration-verification', '--network=none', '--memory=1g', '--cpus=1', '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-e', 'MYSQL_DATABASE=website_test', image['Id'], '--skip-name-resolve')
        created = True
        for _ in range(90):
            if cli('exec', name, 'mysql', '-uroot', 'website_test', '-e', 'SELECT 1', check=False).returncode == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError('MySQL fixture did not become ready')
        sql("CREATE TABLE bundle (bundle_id VARCHAR(64) PRIMARY KEY, features JSON); INSERT INTO bundle VALUES ('bundle_launch_fixture',JSON_OBJECT());")
        sql((ROOT / 'ctl/migrations/000028_create_static_website_platform.up.sql').read_text())
        sql("INSERT INTO website_sites(site_id,user_id,pass_id,bundle_id,status,cloud_path,public_url) VALUES ('ws-static','usr-fixture','pass-fixture','bundle_launch_fixture','active','sites/ws-static/wr-static/','https://ws-static.invalid'); INSERT INTO website_releases(release_id,site_id,user_id,status) VALUES ('wr-static','ws-static','usr-fixture','active');")
        original = sql('SELECT site_id,user_id,cloud_path,public_url,status,operation_generation,storage_bytes FROM website_sites;')
        up = (ROOT / 'ctl/migrations/000032_website_backend_revision.up.sql').read_text()
        down = (ROOT / 'ctl/migrations/000032_website_backend_revision.down.sql').read_text()
        sql(up)
        check('existing static site unchanged', original == sql('SELECT site_id,user_id,cloud_path,public_url,status,operation_generation,storage_bytes FROM website_sites;'))
        check('static defaults applied to existing site and release', sql("SELECT kind,CHAR_LENGTH(active_release_id),CHAR_LENGTH(backend_sha256) FROM website_sites; SELECT kind,CHAR_LENGTH(backend_sha256) FROM website_releases;") == 'static\t0\t0\nstatic\t0')
        sql("INSERT INTO website_sites(site_id,user_id,pass_id,bundle_id,status,cloud_path,public_url) VALUES ('ws-legacy-client','usr-fixture','pass-fixture','bundle_launch_fixture','active','sites/ws-legacy/','https://ws-legacy.invalid');")
        check('legacy insert omitting new fields remains compatible', sql("SELECT kind FROM website_sites WHERE site_id='ws-legacy-client'") == 'static')
        sql("START TRANSACTION; UPDATE website_sites SET kind='fullstack',active_release_id='wr-static',backend_sha256=REPEAT('a',64) WHERE site_id='ws-static'; UPDATE website_releases SET kind='fullstack',backend_sha256=REPEAT('a',64) WHERE release_id='wr-static'; COMMIT;")
        check('paired backend metadata persists', sql("SELECT s.kind=r.kind AND s.backend_sha256=r.backend_sha256 AND LENGTH(s.backend_sha256)=64 FROM website_sites s JOIN website_releases r ON s.active_release_id=r.release_id WHERE s.site_id='ws-static'") == '1')
        # First return the fixture to static, matching the destructive-down gate.
        sql("UPDATE website_sites SET kind='static',active_release_id='',backend_sha256=''; UPDATE website_releases SET kind='static',backend_sha256='';")
        sql(down)
        check('down preserves legacy rows', sql('SELECT COUNT(*) FROM website_sites') == '2' and sql('SELECT COUNT(*) FROM website_releases') == '1')
        check('down removes exactly new columns', sql("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='website_test' AND TABLE_NAME IN ('website_sites','website_releases') AND COLUMN_NAME IN ('kind','active_release_id','backend_sha256')") == '0')
        sql(up)
        check('up works after down', sql("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='website_test' AND TABLE_NAME IN ('website_sites','website_releases') AND COLUMN_NAME IN ('kind','active_release_id','backend_sha256')") == '5')
        check('bundle quota seed preserved', sql("SELECT JSON_EXTRACT(static_site_quota,'$.max_sites') FROM bundle") == '1')
        report['status'] = 'passed'
    finally:
        if created:
            cli('rm', '-f', '-v', name)
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    raise SystemExit(main())
