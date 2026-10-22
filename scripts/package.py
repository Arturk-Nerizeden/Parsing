from pathlib import Path
from shutil import copyfile
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
target = root / 'dist' / 'telegram-username-collector.zip'
target.parent.mkdir(exist_ok=True)
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for file in sorted((root / 'extension').rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(root / 'extension'))
    archive.write(root / 'README.md', 'README.md')
    archive.write(root / 'docs' / 'RESEARCH.md', 'docs/RESEARCH.md')
target.chmod(0o644)
download = root / 'downloads' / 'telegram-username-collector-v1.0.0.zip'
download.parent.mkdir(exist_ok=True)
copyfile(target, download)
download.chmod(0o644)
print(download)
