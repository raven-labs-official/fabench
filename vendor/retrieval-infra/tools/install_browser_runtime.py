"""Install pinned Playwright Chromium and, on Ubuntu 24.04, missing user-local libraries.

No sudo or system package changes. apt verifies downloads against configured package
metadata; exact package versions and archive hashes are retained with the browser.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile

PACKAGES = {
    'libatk-1.0.so.0':'libatk1.0-0t64', 'libatk-bridge-2.0.so.0':'libatk-bridge2.0-0t64',
    'libatspi.so.0':'libatspi2.0-0t64', 'libcups.so.2':'libcups2t64',
    'libXcomposite.so.1':'libxcomposite1', 'libXdamage.so.1':'libxdamage1',
    'libXfixes.so.3':'libxfixes3', 'libXrandr.so.2':'libxrandr2',
    'libgbm.so.1':'libgbm1', 'libasound.so.2':'libasound2t64',
    'libwayland-server.so.0':'libwayland-server0', 'libdrm.so.2':'libdrm2',
    'libXi.so.6':'libxi6',
    'libxshmfence.so.1':'libxshmfence1', 'libXrender.so.1':'libxrender1',
    'libnss3.so':'libnss3', 'libnspr4.so':'libnspr4', 'libxkbcommon.so.0':'libxkbcommon0',
}

def main():
    root=Path(os.environ.get('PLAYWRIGHT_BROWSERS_PATH') or Path(sys.prefix).parent/'.playwright').resolve()
    os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(root)
    subprocess.run([sys.executable,'-m','playwright','install','chromium','--only-shell'],check=True)
    if platform.system()!='Linux': return
    shells=list(root.glob('chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))
    if len(shells)!=1: raise RuntimeError('Expected one pinned Chromium headless shell')
    libs=root/'system-libs'
    env=dict(os.environ,LD_LIBRARY_PATH=str(libs/'usr/lib/x86_64-linux-gnu'))
    manifest_path=root/'system-libraries.json'
    records=json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    for _ in range(6):
        report=subprocess.run(['ldd',str(shells[0])],text=True,capture_output=True,env=env,check=True).stdout
        missing=sorted(set(re.findall(r'^\s*(\S+)\s+=> not found',report,re.M)))
        if not missing:
            manifest_path.write_text(json.dumps(records,indent=2)+'\n')
            print('[OK] Chromium shared libraries resolved; local packages='+str(len(records)))
            return
        os_release=Path('/etc/os-release').read_text()
        if 'ID=ubuntu\n' not in os_release or 'VERSION_ID="24.04"' not in os_release or platform.machine()!='x86_64':
            raise RuntimeError('Missing Chromium libraries '+str(missing)+'; install Playwright system dependencies for this OS')
        unknown=set(missing)-PACKAGES.keys()
        if unknown: raise RuntimeError('Unmapped missing Chromium libraries: '+str(sorted(unknown)))
        for package in sorted({PACKAGES[name] for name in missing}):
            policy=subprocess.run(['apt-cache','policy',package],text=True,capture_output=True,check=True).stdout
            candidate=re.search(r'Candidate:\s+(\S+)',policy)
            if not candidate or candidate[1]=='(none)': raise RuntimeError('No apt candidate for '+package)
            version=candidate[1]
            with tempfile.TemporaryDirectory(prefix='raven-browser-deb-') as temp:
                subprocess.run(['apt-get','download',package+'='+version],cwd=temp,check=True)
                archives=list(Path(temp).glob('*.deb'))
                if len(archives)!=1: raise RuntimeError('Expected one package archive')
                archive=archives[0]
                libs.mkdir(parents=True,exist_ok=True)
                subprocess.run(['dpkg-deb','-x',str(archive),str(libs)],check=True)
                records.append(dict(package=package,version=version,archive=archive.name,
                    sha256=hashlib.sha256(archive.read_bytes()).hexdigest()))
                manifest_path.write_text(json.dumps(records,indent=2)+'\n')
    raise RuntimeError('Chromium dependencies did not converge')

if __name__=='__main__': main()
