// onnxruntime-react-native ships a legacy unimodule.json, so Expo autolinking takes it as an Expo module on Android and
// never registers its React package; this links it as the React Native library it is.
module.exports = {
  dependencies: {
    "onnxruntime-react-native": {
      platforms: {
        android: {
          packageImportPath: "import ai.onnxruntime.reactnative.OnnxruntimePackage;",
          packageInstance: "new OnnxruntimePackage()",
        },
      },
    },
  },
};
