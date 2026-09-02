if (typeof Array.prototype.toReversed !== 'function') {
  Object.defineProperty(Array.prototype, 'toReversed', {
    configurable: true,
    writable: true,
    value() {
      return this.slice().reverse();
    },
  });
}

const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
