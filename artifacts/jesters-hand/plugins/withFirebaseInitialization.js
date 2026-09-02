const { withAppBuildGradle, withMainApplication } = require('expo/config-plugins');

const IMPORT_KOTLIN = 'import com.google.firebase.FirebaseApp';
const IMPORT_JAVA = 'import com.google.firebase.FirebaseApp;';
const FIREBASE_MESSAGING_DEPENDENCY =
  'implementation("com.google.firebase:firebase-messaging:24.0.1")';

module.exports = function withFirebaseInitialization(config) {
  const configWithFirebaseDependency = withAppBuildGradle(config, (configWithBuildGradle) => {
    let source = configWithBuildGradle.modResults.contents;
    if (!source.includes(FIREBASE_MESSAGING_DEPENDENCY)) {
      if (!source.includes('dependencies {')) {
        throw new Error('Could not find the Android app dependencies block.');
      }
      source = source.replace(
        'dependencies {',
        `dependencies {\n    ${FIREBASE_MESSAGING_DEPENDENCY}`,
      );
    }
    configWithBuildGradle.modResults.contents = source;
    return configWithBuildGradle;
  });

  return withMainApplication(configWithFirebaseDependency, (configWithMainApplication) => {
    const mainApplication = configWithMainApplication.modResults;
    const isJava = mainApplication.language === 'java';
    const importLine = isJava ? IMPORT_JAVA : IMPORT_KOTLIN;
    const initializeLine = isJava
      ? '    FirebaseApp.initializeApp(this);'
      : '    FirebaseApp.initializeApp(this)';

    let source = mainApplication.contents;

    if (!source.includes(importLine)) {
      const packageMatch = source.match(/^package\s+[^\n;]+;?/m);
      if (!packageMatch) {
        throw new Error('Could not find the Android application package declaration.');
      }
      source = source.replace(packageMatch[0], `${packageMatch[0]}\n\n${importLine}`);
    }

    if (!source.includes('FirebaseApp.initializeApp(this)')) {
      const superCall = isJava ? 'super.onCreate();' : 'super.onCreate()';
      if (!source.includes(superCall)) {
        throw new Error('Could not find MainApplication.onCreate().');
      }
      source = source.replace(superCall, `${superCall}\n${initializeLine}`);
    }

    mainApplication.contents = source;
    return configWithMainApplication;
  });
};