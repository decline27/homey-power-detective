'use strict';

module.exports = {
  async getNow({ homey }) {
    return homey.app.widgetState();
  },
};
