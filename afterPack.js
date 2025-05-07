const fs = require("fs-extra");
const path = require("path");

exports.default = async function (context) {
  const appOutDir = context.appOutDir;
  const resourcesDir = path.join(appOutDir, "resources");
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  const serverSrc = path.join(__dirname, "server");
  const serverDest = path.join(unpackedDir, "server");

  await fs.ensureDir(serverDest);

  await fs.copy(serverSrc, serverDest, {
    dereference: true,
    filter: (src) => {
      return true;
    },
  });
};
