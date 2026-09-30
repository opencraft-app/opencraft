const fs = require('node:fs');
const path = require('node:path');

const gradlePath = path.join(__dirname, '..', 'android', 'app', 'build.gradle');
const source = fs.readFileSync(gradlePath, 'utf8');
const signingStart = '    signingConfigs {\n';
const buildTypesStart = '    buildTypes {\n';
const debugSigning = '            signingConfig signingConfigs.debug';

if (source.split(signingStart).length !== 2 ||
    source.split(buildTypesStart).length !== 2 ||
    source.split(debugSigning).length !== 3) {
  throw new Error('Unexpected generated Android signing configuration; release signing was not applied.');
}

const releaseConfig = `        release {
            def keystorePath = System.getenv('OPENCRAFT_ANDROID_RELEASE_KEYSTORE')
            def passwordFile = System.getenv('OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE')
            def keyAliasValue = System.getenv('OPENCRAFT_ANDROID_RELEASE_KEY_ALIAS')
            if (!keystorePath || !passwordFile || !keyAliasValue) {
                throw new GradleException('Android release signing environment is incomplete')
            }
            storeFile file(keystorePath)
            storeType 'pkcs12'
            storePassword file(passwordFile).text.trim()
            keyAlias keyAliasValue
            keyPassword file(passwordFile).text.trim()
        }
`;

const [beforeBuildTypes, buildTypes] = source.split(buildTypesStart);
const withReleaseConfig = beforeBuildTypes.replace(signingStart, signingStart + releaseConfig);
const releaseBlock = buildTypes.replace(
  /(        release \{[\s\S]*?)            signingConfig signingConfigs\.debug/,
  '$1            signingConfig signingConfigs.release',
);
if (releaseBlock === buildTypes) {
  throw new Error('Unable to select the Android release signing configuration.');
}
fs.writeFileSync(gradlePath, withReleaseConfig + buildTypesStart + releaseBlock);
