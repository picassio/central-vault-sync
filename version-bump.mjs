import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}

// Keep the distributed stylesheet digest release-specific so provenance lookup
// cannot be confused with attestations issued for an older tag's identical CSS.
const stylesPath = 'styles.css';
const styles = readFileSync(stylesPath, 'utf8');
const releaseMarker = `/* central-vault-sync release: ${targetVersion} */\n`;
const updatedStyles = /^\/\* central-vault-sync release: [^\n]+ \*\/\n/.test(styles)
	? styles.replace(/^\/\* central-vault-sync release: [^\n]+ \*\/\n/, releaseMarker)
	: `${releaseMarker}${styles}`;
writeFileSync(stylesPath, updatedStyles);
