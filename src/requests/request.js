import { KinveyRack } from '../rack/rack';
import Client from '../client';
import { KinveyError, NoActiveUserError } from '../errors';
import { byteCount } from '../utils/string';
import UrlPattern from 'url-pattern';
import qs from 'qs';
import url from 'url';
import appendQuery from 'append-query';
import assign from 'lodash/assign';
import result from 'lodash/result';
import forEach from 'lodash/forEach';
import isString from 'lodash/isString';
import isPlainObject from 'lodash/isPlainObject';
import isEmpty from 'lodash/isEmpty';
import isNumber from 'lodash/isNumber';
const appVersionKey = 'appVersion';
const Device = global.KinveyDevice;
const kmdAttribute = process.env.KINVEY_KMD_ATTRIBUTE || '_kmd';
const defaultTimeout = process.env.KINVEY_DEFAULT_TIMEOUT || 30;
const defaultApiVersion = process.env.KINVEY_DEFAULT_API_VERSION || 4;
const customPropertiesMaxBytesAllowed = process.env.KINVEY_MAX_HEADER_BYTES || 2000;

/**
 * Enum for Auth types.
 */
const AuthType = {
  All: 'All',
  App: 'App',
  Basic: 'Basic',
  Default: 'Default',
  Master: 'Master',
  None: 'None',
  Session: 'Session'
};
Object.freeze(AuthType);
export { AuthType };

/**
 * @private
 * Enum for Request Methods.
 */
const RequestMethod = {
  GET: 'GET',
  POST: 'POST',
  PATCH: 'PATCH',
  PUT: 'PUT',
  DELETE: 'DELETE'
};
Object.freeze(RequestMethod);
export { RequestMethod };

const Auth = {
  /**
   * Authenticate through (1) user credentials, (2) Master Secret, or (3) App
   * Secret.
   *
   * @returns {Object}
   */
  all(client) {
    try {
      return Auth.session(client);
    } catch (error) {
      return Auth.basic(client);
    }
  },

  /**
   * Authenticate through App Secret.
   *
   * @returns {Object}
   */
  app(client) {
    if (!client.appKey || !client.appSecret) {
      throw new Error('Missing client credentials');
    }

    return {
      scheme: 'Basic',
      username: client.appKey,
      password: client.appSecret
    };
  },

  /**
   * Authenticate through (1) Master Secret, or (2) App Secret.
   *
   * @returns {Object}
   */
  basic(client) {
    try {
      return Auth.master(client);
    } catch (error) {
      return Auth.app(client);
    }
  },

  /**
   * Authenticate through Master Secret.
   *
   * @returns {Object}
   */
  master(client) {
    if (!client.appKey || !client.masterSecret) {
      throw new Error('Missing client credentials');
    }

    return {
      scheme: 'Basic',
      username: client.appKey,
      password: client.masterSecret
    };
  },

  /**
   * Do not authenticate.
   *
   * @returns {Null}
   */
  none() {
    return null;
  },

  /**
   * Authenticate through user credentials.
   *
   * @returns {Object}
   */
  session(client) {
    const activeUser = client.activeUser;

    if (!activeUser) {
      throw new NoActiveUserError('There is not an active user. Please login a user and retry the request.');
    }

    return {
      scheme: 'Kinvey',
      credentials: activeUser[kmdAttribute].authtoken
    };
  }
};

class Headers {
  constructor(headers = {}) {
    this.addAll(headers);
  }

  get(name) {
    if (name) {
      if (!isString(name)) {
        name = String(name);
      }

      const headers = this.headers || {};
      const keys = Object.keys(headers);

      for (let i = 0, len = keys.length; i < len; i++) {
        const key = keys[i];

        if (key.toLowerCase() === name.toLowerCase()) {
          return headers[key];
        }
      }
    }

    return undefined;
  }

  set(name, value) {
    if (!name || !value) {
      throw new Error('A name and value must be provided to set a header.');
    }

    if (!isString(name)) {
      name = String(name);
    }

    const headers = this.headers || {};

    if (!isString(value)) {
      headers[name] = JSON.stringify(value);
    } else {
      headers[name] = value;
    }

    this.headers = headers;
  }

  has(name) {
    return !!this.get(name);
  }

  add(header = {}) {
    return this.setHeader(header.name, header.value);
  }

  addAll(headers) {
    if (!isPlainObject(headers)) {
      throw new Error('Headers argument must be an object.');
    }

    const names = Object.keys(headers);

    forEach(names, name => {
      const value = headers[name];
      this.setHeader(name, value);
    });
  }

  remove(name) {
    if (name) {
      if (!isString(name)) {
        name = String(name);
      }

      const headers = this.headers || {};
      delete headers[name];
      this.headers = headers;
    }
  }

  clear() {
    this.headers = {};
  }

  toJSON() {
    return this.headers;
  }
}

class Properties {
  /**
   * Returns the request property for the key or `undefined` if
   * it has not been set.
   *
   * @param  {String} key Request property key
   * @return {*} Request property value
   */
  get(key) {
    const properties = this.toJSON();

    if (key && properties.hasOwnProperty(key)) {
      return properties[key];
    }

    return undefined;
  }

  /**
   * Sets the request property key to the value.
   *
   * @param {String} key Request property key
   * @param {*} value Request property value
   * @return {RequestProperties} The request properties instance.
   */
  set(key, value) {
    const properties = {};
    properties[key] = value;
    this.addProperties(properties);
    return this;
  }

  remove(key) {
    const properties = this.properties;

    if (key && properties.hasOwnProperty(key)) {
      delete properties[key];
    }
  }

  has(key) {
    return !!this.get(key);
  }

  addProperties(properties) {
    if (!isPlainObject(properties)) {
      throw new KinveyError('properties argument must be an object');
    }

    Object.keys(properties).forEach((key) => {
      const value = properties[key];

      if (value) {
        this.properties[key] = value;
      } else {
        delete this.properties[key];
      }
    });
  }

  clear() {
    this.properties = {};
  }
}

/**
 * Request Properties class
 */
export class RequestConfig {
  constructor(options = {}) {
    options = assign({
      method: RequestMethod.GET,
      headers: new Headers(),
      url: '',
      body: null,
      timeout: defaultTimeout,
      followRedirect: true,
      noCache: false
    }, options);

    this.method = options.method;
    this.headers = options.headers;
    this.url = options.url;
    this.body = options.body;
    this.timeout = options.timeout;
    this.followRedirect = options.followRedirect;
    this.noCache = options.noCache;

    const headers = this.headers;

    if (!headers.has('accept')) {
      headers.set('accept', 'application/json; charset=utf-8');
    }

    this.headers = headers;
  }

  get method() {
    return this.configMethod;
  }

  set method(method) {
    if (!isString(method)) {
      method = String(method);
    }

    method = method.toUpperCase();
    switch (method) {
      case RequestMethod.GET:
      case RequestMethod.POST:
      case RequestMethod.PATCH:
      case RequestMethod.PUT:
      case RequestMethod.DELETE:
        this.configMethod = method;
        break;
      default:
        throw new Error('Invalid request method. Only GET, POST, PATCH, PUT, and DELETE are allowed.');
    }
  }

  get headers() {
    return this.configHeaders;
  }

  set headers(headers) {
    if (!(headers instanceof Headers)) {
      headers = new Headers(result(headers, 'toJSON', headers));
    }

    this.configHeaders = headers;
  }

  get url() {
    // Unless `noCache` is true, add a cache busting query string.
    // This is useful for Android < 4.0 which caches all requests aggressively.
    if (this.noCache) {
      return appendQuery(this.configUrl, qs.stringify({
        _: Math.random().toString(36).substr(2)
      }));
    }

    return this.configUrl;
  }

  set url(urlString) {
    this.configUrl = urlString;
  }

  get body() {
    return this.configBody;
  }

  set body(body) {
    this.configBody = body;
  }

  get data() {
    return this.body;
  }

  set data(data) {
    this.body = data;
  }

  get timeout() {
    return this.configTimeout;
  }

  set timeout(timeout) {
    this.configTimeout = isNumber(timeout) ? timeout : defaultTimeout;
  }

  get followRedirect() {
    return this.configFollowRedirect;
  }

  set followRedirect(followRedirect) {
    this.configFollowRedirect = !!followRedirect;
  }

  get noCache() {
    return this.configNoCache;
  }

  set noCache(noCache) {
    this.configNoCache = !!noCache;
  }
}

export class KinveyRequestConfig extends RequestConfig {
  constructor(options = {}) {
    super(options);

    options = assign({
      authType: AuthType.None,
      contentType: 'application/json; charseutf-8',
      query: null,
      online: true,
      cacheEnabled: true,
      apiVersion: defaultApiVersion,
      properties: {},
      skipBL: false,
      trace: false,
      client: Client.sharedInstance()
    }, options);

    this.authType = options.authType;
    this.query = options.query;
    this.online = options.online;
    this.cacheEnabled = options.cacheEnabled;
    this.timeout = options.timeout;
    this.apiVersion = options.apiVersion;
    this.properties = options.properties;
    this.client = options.client;

    const headers = this.headers;

    if (!headers.has('X-Kinvey-Api-Version')) {
      headers.set('X-Kinvey-Api-Version', this.apiVersion);
    }

    if (Device) {
      headers.set('X-Kinvey-Device-Information', JSON.stringify(Device.toJSON()));
    }

    if (options.contentType) {
      headers.set('X-Kinvey-Content-Type', options.contentType);
    }

    if (options.skipBL === true) {
      headers.set('X-Kinvey-Skip-Business-Logic', true);
    }

    if (options.trace === true) {
      headers.set('X-Kinvey-Include-Headers-In-Response', 'X-Kinvey-Request-Id');
      headers.set('X-Kinvey-ResponseWrapper', true);
    }

    this.headers = headers;
  }

  get headers() {
    const headers = super.headers;

    if (this.appVersion) {
      headers.set('X-Kinvey-Client-App-Version', this.appVersion);
    } else {
      headers.remove('X-Kinvey-Client-App-Version');
    }

    const customPropertiesHeader = JSON.stringify(this.properties);
    const customPropertiesByteCount = byteCount(customPropertiesHeader);

    if (customPropertiesByteCount >= customPropertiesMaxBytesAllowed) {
      throw new Error(
        `The custom properties are ${customPropertiesByteCount} bytes.` +
        `It must be less then ${customPropertiesMaxBytesAllowed} bytes.`,
        'Please remove some custom properties.');
    }

    this.headers.set('X-Kinvey-Custom-Request-Properties', customPropertiesHeader);
  }

  set headers(headers) {
    super.headers = headers;
  }

  get url() {
    const urlString = super.url;
    const queryString = this.query ? this.query.toQueryString() : {};

    if (isEmpty(queryString)) {
      return urlString;
    }

    return appendQuery(urlString, qs.stringify(queryString));
  }

  set url(urlString) {
    super.url = urlString;
    const pathname = global.escape(url.parse(urlString).pathname);
    const pattern = new UrlPattern('(/:namespace)(/)(:appKey)(/)(:collection)(/)(:entityId)(/)');
    const { appKey, collection, entityId } = pattern.match(pathname) || {};
    this.appKey = !!appKey ? global.unescape(appKey) : appKey;
    this.collection = !!collection ? global.unescape(collection) : collection;
    this.entityId = !!entityId ? global.unescape(entityId) : entityId;
  }

  get apiVersion() {
    return this.configApiVersion;
  }

  set apiVersion(apiVersion) {
    this.configApiVersion = isNumber(apiVersion) ? apiVersion : defaultApiVersion;
  }

  get online() {
    return this.configOnline;
  }

  set online(online) {
    this.configOnline = !!online;
  }

  get cacheEnabled() {
    return this.configCacheEnabled;
  }

  set cacheEnabled(cacheEnabled) {
    this.configCacheEnabled = !!cacheEnabled;
  }

  get properties() {
    return this.configProperties;
  }

  set properties(properties) {
    this.configProperties = properties;
  }

  /**
   * Return the app version request property.
   *
   * @return {String} App version
   */
  get appVersion() {
    return this.configAppVersion;
  }

  /**
   * Set the app version request property. The app version can be provided
   * in major.minor.patch format or something specific to your application.
   *
   * @param  {Any} version App version.
   * @return {RequestProperties} The request properties instance.
   */
  set appVersion(args) {
    const version = Array.prototype.slice.call(args, 1);
    const major = args[0];
    const minor = version[1];
    const patch = version[2];
    let appVersion = '';

    if (major) {
      appVersion = `${major}`.trim();
    }

    if (minor) {
      appVersion = `.${minor}`.trim();
    }

    if (patch) {
      appVersion = `.${patch}`.trim();
    }

    this.configAppVersion = appVersion;
  }
}

/**
 * @private
 */
export class Request {
  constructor(config = new RequestConfig()) {
    this.config = config;
    this.executing = false;
  }

  get config() {
    return this.requestConfig;
  }

  set config(config) {
    if (config && !(config instanceof RequestConfig)) {
      config = new RequestConfig(result(config, 'toJSON', config));
    }

    this.requestConfig = config;
  }

  get method() {
    return this.config.method;
  }

  set method(method) {
    this.config.method = method;
  }

  get headers() {
    return this.config.headers;
  }

  set headers(headers) {
    this.config.headers = headers;
  }

  get url() {
    return this.config.url;
  }

  set url(urlString) {
    this.config.url = urlString;
  }

  get body() {
    return this.config.body;
  }

  set body(body) {
    this.config.body = body;
  }

  get data() {
    return this.body;
  }

  set data(data) {
    this.body = data;
  }

  isExecuting() {
    return !!this.executing;
  }

  async execute() {
    if (this.isExecuting()) {
      throw new Error('Unable to execute the request. The request is already executing.');
    }

    // Flip the executing flag to true
    this.executing = true;
  }

  toJSON() {
    const json = {
      method: this.method,
      headers: this.headers.toJSON(),
      url: this.url,
      body: this.body,
      data: this.body
    };

    return json;
  }
}

/**
 * @private
 */
export class KinveyRequest extends Request {
  constructor(config = new RequestConfig()) {
    super(config);
    this.rack = new KinveyRack();
  }

  get url() {
    const urlString = super.url;
    const queryString = this.query ? this.query.toQueryString() : {};

    if (isEmpty(queryString)) {
      return urlString;
    }

    return appendQuery(urlString, qs.stringify(queryString));
  }

  get authorizationHeader() {
    let authInfo;

    switch (this.authType) {
      case AuthType.All:
        authInfo = Auth.all(this.client);
        break;
      case AuthType.App:
        authInfo = Auth.app(this.client);
        break;
      case AuthType.Basic:
        authInfo = Auth.basic(this.client);
        break;
      case AuthType.Master:
        authInfo = Auth.master(this.client);
        break;
      case AuthType.None:
        authInfo = Auth.none(this.client);
        break;
      case AuthType.Session:
        authInfo = Auth.session(this.client);
        break;
      default:
        try {
          authInfo = Auth.session(this.client);
        } catch (error) {
          try {
            authInfo = Auth.master(this.client);
          } catch (error2) {
            throw error;
          }
        }
    }

    if (authInfo) {
      let credentials = authInfo.credentials;

      if (authInfo.username) {
        credentials = new Buffer(`${authInfo.username}:${authInfo.password}`).toString('base64');
      }

      return {
        name: 'Authorization',
        value: `${authInfo.scheme} ${credentials}`
      };
    }

    return null;
  }

  execute() {
    const authorizationHeader = this.authorizationHeader;

    if (authorizationHeader) {
      this.addHeader(authorizationHeader);
    }

    return super.execute();
  }

  cancel() {
    return super.cancel();
  }

  toJSON() {
    const json = super.toJSON();
    json.query = this.query;
    return json;
  }
}