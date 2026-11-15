/**
 * mips-erp.js — drop-in client for the browser and for React Native / Cordova.
 *
 * Works in three environments without changes:
 *   - Modern browsers (fetch)
 *   - React Native / Expo (fetch)
 *   - Cordova / Capacitor / older WebViews (XMLHttpRequest fallback)
 *
 * IMPORTANT — never put the ERP apiKey in a mobile or web bundle that ships to
 * users. Point `baseUrl` at YOUR backend proxy (see server-proxy.js) and let it
 * hold the key. Direct calls are supported for local prototyping only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MipsErp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function request(method, url, { body, headers = {}, timeout = 20000 } = {}) {
    return new Promise(function (resolve, reject) {
      var payload = body == null ? null : JSON.stringify(body);
      var hasFetch = typeof fetch === 'function';

      var timer = setTimeout(function () {
        reject(makeError('TIMEOUT', 'Request timed out after ' + timeout + 'ms', 0));
      }, timeout);

      function done(status, text) {
        clearTimeout(timer);
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          /* non-JSON */
        }
        if (status >= 200 && status < 300) return resolve(json);
        var err = json && json.error ? json.error : {};
        reject(makeError(err.code || 'HTTP_' + status, err.message || 'Request failed', status, json));
      }

      if (hasFetch) {
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        fetch(url, {
          method: method,
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: payload,
          signal: controller ? controller.signal : undefined,
        })
          .then(function (res) {
            return res.text().then(function (t) {
              done(res.status, t);
            });
          })
          .catch(function (e) {
            clearTimeout(timer);
            reject(makeError('NETWORK', e.message || 'Network error', 0));
          });
      } else {
        // XHR fallback path for old WebViews
        var xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        Object.keys(headers).forEach(function (k) {
          xhr.setRequestHeader(k, headers[k]);
        });
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) done(xhr.status, xhr.responseText);
        };
        xhr.onerror = function () {
          clearTimeout(timer);
          reject(makeError('NETWORK', 'Network error', 0));
        };
        xhr.send(payload);
      }
    });
  }

  function makeError(code, message, status, body) {
    var e = new Error(message);
    e.code = code;
    e.status = status;
    e.body = body;
    return e;
  }

  function MipsErp(opts) {
    opts = opts || {};
    this.baseUrl = (opts.baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
    this.token = opts.token || null; // proxy session token, or ERP apiKey in direct mode
    this.mode = opts.mode || 'proxy'; // 'proxy' | 'direct'
    this.timeout = opts.timeout || 20000;
  }

  /** Proxy mode: log in through your own backend. Returns its session token. */
  MipsErp.prototype.proxyLogin = function (userId, password) {
    var self = this;
    return request('POST', self.baseUrl + '/api/erp/login', {
      body: { userId: userId, password: password },
      timeout: 45000, // OCR retries can take a few seconds
    }).then(function (res) {
      self.token = res.token || (res.data && res.data.token);
      return res;
    });
  };

  /** Direct mode only (prototyping): call mips-erp-api straight. */
  MipsErp.prototype.directLogin = function (userId, password, institute) {
    var self = this;
    return request('POST', self.baseUrl + '/v1/auth/login', {
      body: { userId: userId, password: password, institute: institute || 'MIPS' },
      timeout: 45000,
    }).then(function (res) {
      self.token = res.data.apiKey;
      return res.data;
    });
  };

  /** Manual captcha flow for either mode. `onCaptcha(dataUrl)` returns a Promise of the typed answer. */
  MipsErp.prototype.loginWithCaptcha = function (userId, password, onCaptcha, institute) {
    var self = this;
    var capPath = self.mode === 'proxy' ? '/api/erp/captcha' : '/v1/auth/captcha';
    return request('POST', self.baseUrl + capPath, {
      body: { institute: institute || 'MIPS' },
    })
      .then(function (res) {
        var d = res.data || res;
        var sessionId = d.sessionId;
        var image = d.captchaImage;

        function attempt(n) {
          if (n > 5) return Promise.reject(makeError('CAPTCHA_EXHAUSTED', 'Too many captcha attempts', 0));
          return Promise.resolve(onCaptcha(image, n)).then(function (answer) {
            var loginPath = self.mode === 'proxy' ? '/api/erp/login-captcha' : '/v1/auth/login';
            return request('POST', self.baseUrl + loginPath, {
              body: { sessionId: sessionId, userId: userId, password: password, captcha: answer },
            }).then(
              function (ok) {
                self.token = ok.token || (ok.data && ok.data.apiKey);
                return ok;
              },
              function (err) {
                if (err.code === 'INVALID_CAPTCHA' && err.body && err.body.data) {
                  sessionId = err.body.data.sessionId || sessionId;
                  image = err.body.data.captchaImage || image;
                  return attempt(n + 1);
                }
                throw err;
              }
            );
          });
        }
        return attempt(1);
      });
  };

  MipsErp.prototype._req = function (path, opts) {
    var headers = {};
    if (this.token) {
      headers[this.mode === 'proxy' ? 'X-Session-Token' : 'Authorization'] = this.mode === 'proxy' ? this.token : 'Bearer ' + this.token;
    }
    return request('GET', this.baseUrl + (this.mode === 'proxy' ? '/api/erp' : '/v1') + path, {
      headers: headers,
      timeout: (opts && opts.timeout) || this.timeout,
    }).then(function (res) {
      // proxy unwraps mips-erp-api's {ok,data} envelope; direct uses {ok,data} too
      return res && res.ok === true && 'data' in res ? res.data : res;
    });
  };

  MipsErp.prototype.dashboard = function () { return this._req('/dashboard', { timeout: 30000 }); };
  MipsErp.prototype.profile = function () { return this._req('/student/profile'); };
  MipsErp.prototype.subjects = function () { return this._req('/student/subjects'); };
  MipsErp.prototype.timetable = function () { return this._req('/student/timetable'); };
  MipsErp.prototype.attendance = function () { return this._req('/student/attendance'); };
  MipsErp.prototype.assessment = function () { return this._req('/student/assessment'); };
  MipsErp.prototype.classmates = function () { return this._req('/student/classmates'); };
  MipsErp.prototype.documents = function () { return this._req('/student/documents'); };
  MipsErp.prototype.holidays = function () { return this._req('/calendar/holidays'); };
  MipsErp.prototype.notices = function (opts) {
    var q = opts
      ? Object.keys(opts)
          .filter(function (k) { return opts[k] != null; })
          .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(opts[k]); })
          .join('&')
      : '';
    return this._req('/notices' + (q ? '?' + q : ''));
  };

  MipsErp.prototype.logout = function () {
    var self = this;
    var path = self.mode === 'proxy' ? '/api/erp/logout' : '/v1/auth/logout';
    return request('POST', self.baseUrl + path, {
      headers: self.token
        ? self.mode === 'proxy'
          ? { 'X-Session-Token': self.token }
          : { Authorization: 'Bearer ' + self.token }
        : {},
    }).catch(function () {});
  };

  return MipsErp;
});
