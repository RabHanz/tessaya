module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    // TESSAYA_BRAND=1 brands a development bundle too, so a dev client on Metro reads as the Tessaya app.
    plugins:
      process.env.APP_VARIANT === "tessaya" || process.env.TESSAYA_BRAND === "1"
        ? ["./plugins/tessayaBrandBabel.cjs"]
        : [],
  };
};
