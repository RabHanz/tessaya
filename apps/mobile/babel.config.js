module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins: process.env.APP_VARIANT === "tessaya" ? ["./plugins/tessayaBrandBabel.cjs"] : [],
  };
};
