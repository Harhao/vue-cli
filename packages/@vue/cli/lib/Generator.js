const ejs = require('ejs')
const debug = require('debug')
const GeneratorAPI = require('./GeneratorAPI')
// 安装包管理类
const PackageManager = require('./util/ProjectPackageManager')
// 对依赖项进行排序处理
const sortObject = require('./util/sortObject')
// 写入文件夹树
const writeFileTree = require('./util/writeFileTree')
const inferRootOptions = require('./util/inferRootOptions')
// 序列化文件路径
const normalizeFilePaths = require('./util/normalizeFilePaths')
const runCodemod = require('./util/runCodemod')
const {
  semver,

  isPlugin,
  toShortPluginId,
  matchesPluginId,

  loadModule
} = require('@vue/cli-shared-utils')
const ConfigTransform = require('./ConfigTransform')

const logger = require('@vue/cli-shared-utils/lib/logger')
const logTypes = {
  log: logger.log,
  info: logger.info,
  done: logger.done,
  warn: logger.warn,
  error: logger.error
}
// 默认配置配置文件
const defaultConfigTransforms = {
  babel: new ConfigTransform({
    file: {
      js: ['babel.config.js']
    }
  }),
  postcss: new ConfigTransform({
    file: {
      js: ['postcss.config.js'],
      json: ['.postcssrc.json', '.postcssrc'],
      yaml: ['.postcssrc.yaml', '.postcssrc.yml']
    }
  }),
  eslintConfig: new ConfigTransform({
    file: {
      js: ['.eslintrc.js'],
      json: ['.eslintrc', '.eslintrc.json'],
      yaml: ['.eslintrc.yaml', '.eslintrc.yml']
    }
  }),
  jest: new ConfigTransform({
    file: {
      js: ['jest.config.js']
    }
  }),
  browserslist: new ConfigTransform({
    file: {
      lines: ['.browserslistrc']
    }
  })
}
// 
const reservedConfigTransforms = {
  vue: new ConfigTransform({
    file: {
      js: ['vue.config.js']
    }
  })
}

const ensureEOL = str => {
  if (str.charAt(str.length - 1) !== '\n') {
    return str + '\n'
  }
  return str
}

module.exports = class Generator {
  // context: 需要生成目录的路径 pkg: package.json的选项，plugins: preset定义的plugin，afterInvokeCbs：调用后的回调函数 ，afterAnyInvokeCbs： 一些调用后的回调函数
  constructor (context, {
    pkg = {},
    plugins = [],
    afterInvokeCbs = [],
    afterAnyInvokeCbs = [],
    files = {},
    invoking = false
  } = {}) {
    this.context = context
    this.plugins = plugins
    this.originalPkg = pkg
    this.pkg = Object.assign({}, pkg)
    this.pm = new PackageManager({ context })
    this.imports = {}
    this.rootOptions = {}
    // we don't load the passed afterInvokes yet because we want to ignore them from other plugins
    this.passedAfterInvokeCbs = afterInvokeCbs
    this.afterInvokeCbs = []
    this.afterAnyInvokeCbs = afterAnyInvokeCbs
    this.configTransforms = {} //允许插件怎么定义分出来的配置文件命名
    this.defaultConfigTransforms = defaultConfigTransforms //允许插件怎么定义分出来的配置文件命名
    this.reservedConfigTransforms = reservedConfigTransforms //允许插件怎么定义分出来的配置文件命名
    this.invoking = invoking
    // for conflict resolution
    this.depSources = {}
    // virtual file tree
    this.files = files
    this.fileMiddlewares = []
    this.postProcessFilesCbs = []
    // exit messages
    this.exitLogs = []

    // load all the other plugins
    // 加载所有的插件
    this.allPluginIds = Object.keys(this.pkg.dependencies || {})
      .concat(Object.keys(this.pkg.devDependencies || {}))
      .filter(isPlugin)
    // 获取cli-service插件
    const cliService = plugins.find(p => p.id === '@vue/cli-service')
    const rootOptions = cliService
      ? cliService.options
      : inferRootOptions(pkg)
    //保存@vue/vli-service的options
    this.rootOptions = rootOptions
  }

  async initPlugins () {
    const { rootOptions, invoking } = this
    const pluginIds = this.plugins.map(p => p.id)

    // apply hooks from all plugins
    for (const id of this.allPluginIds) {
      const api = new GeneratorAPI(id, this, {}, rootOptions)
      const pluginGenerator = loadModule(`${id}/generator`, this.context)

      if (pluginGenerator && pluginGenerator.hooks) {
        await pluginGenerator.hooks(api, {}, rootOptions, pluginIds)
      }
    }

    // We are doing save/load to make the hook order deterministic
    // save "any" hooks
    const afterAnyInvokeCbsFromPlugins = this.afterAnyInvokeCbs

    // reset hooks
    this.afterInvokeCbs = this.passedAfterInvokeCbs
    this.afterAnyInvokeCbs = []
    this.postProcessFilesCbs = []

    // apply generators from plugins
    for (const plugin of this.plugins) {
      const { id, apply, options } = plugin
      const api = new GeneratorAPI(id, this, options, rootOptions)
      await apply(api, options, rootOptions, invoking)

      if (apply.hooks) {
        // while we execute the entire `hooks` function,
        // only the `afterInvoke` hook is respected
        // because `afterAnyHooks` is already determined by the `allPluginIds` loop above
        await apply.hooks(api, options, rootOptions, pluginIds)
      }

      // restore "any" hooks
      this.afterAnyInvokeCbs = afterAnyInvokeCbsFromPlugins
    }
  }

  async generate ({
    extractConfigFiles = false,
    checkExisting = false
  } = {}) {
    await this.initPlugins()

    // save the file system before applying plugin for comparison
    const initialFiles = Object.assign({}, this.files)
    // extract configs from package.json into dedicated files.
    this.extractConfigFiles(extractConfigFiles, checkExisting)
    // wait for file resolve
    await this.resolveFiles()
    // set package.json
    this.sortPkg()
    this.files['package.json'] = JSON.stringify(this.pkg, null, 2) + '\n'
    // write/update file tree to disk
    await writeFileTree(this.context, this.files, initialFiles)
  }

  extractConfigFiles (extractAll, checkExisting) {
    const configTransforms = Object.assign({},
      defaultConfigTransforms,
      this.configTransforms,
      reservedConfigTransforms
    )
    const extract = key => {
      if (
        configTransforms[key] &&
        this.pkg[key] &&
        // do not extract if the field exists in original package.json
        !this.originalPkg[key]
      ) {
        const value = this.pkg[key]
        const configTransform = configTransforms[key]
        const res = configTransform.transform(
          value,
          checkExisting,
          this.files,
          this.context
        )
        const { content, filename } = res
        this.files[filename] = ensureEOL(content)
        delete this.pkg[key]
      }
    }
    if (extractAll) {
      for (const key in this.pkg) {
        extract(key)
      }
    } else {
      if (!process.env.VUE_CLI_TEST) {
        // by default, always extract vue.config.js
        extract('vue')
      }
      // always extract babel.config.js as this is the only way to apply
      // project-wide configuration even to dependencies.
      // TODO: this can be removed when Babel supports root: true in package.json
      extract('babel')
    }
  }

  sortPkg () {
    // ensure package.json keys has readable order
    this.pkg.dependencies = sortObject(this.pkg.dependencies)
    this.pkg.devDependencies = sortObject(this.pkg.devDependencies)
    this.pkg.scripts = sortObject(this.pkg.scripts, [
      'serve',
      'build',
      'test:unit',
      'test:e2e',
      'lint',
      'deploy'
    ])
    this.pkg = sortObject(this.pkg, [
      'name',
      'version',
      'private',
      'description',
      'author',
      'scripts',
      'main',
      'module',
      'browser',
      'jsDelivr',
      'unpkg',
      'files',
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'vue',
      'babel',
      'eslintConfig',
      'prettier',
      'postcss',
      'browserslist',
      'jest'
    ])

    debug('vue:cli-pkg')(this.pkg)
  }

  async resolveFiles () {
    const files = this.files
    for (const middleware of this.fileMiddlewares) {
      await middleware(files, ejs.render)
    }

    // normalize file paths on windows
    // all paths are converted to use / instead of \
    normalizeFilePaths(files)

    // handle imports and root option injections
    Object.keys(files).forEach(file => {
      let imports = this.imports[file]
      imports = imports instanceof Set ? Array.from(imports) : imports
      if (imports && imports.length > 0) {
        files[file] = runCodemod(
          require('./util/codemods/injectImports'),
          { path: file, source: files[file] },
          { imports }
        )
      }

      let injections = this.rootOptions[file]
      injections = injections instanceof Set ? Array.from(injections) : injections
      if (injections && injections.length > 0) {
        files[file] = runCodemod(
          require('./util/codemods/injectOptions'),
          { path: file, source: files[file] },
          { injections }
        )
      }
    })

    for (const postProcess of this.postProcessFilesCbs) {
      await postProcess(files)
    }
    debug('vue:cli-files')(this.files)
  }

  hasPlugin (_id, _version) {
    return [
      ...this.plugins.map(p => p.id),
      ...this.allPluginIds
    ].some(id => {
      if (!matchesPluginId(_id, id)) {
        return false
      }

      if (!_version) {
        return true
      }

      const version = this.pm.getInstalledVersion(id)
      return semver.satisfies(version, _version)
    })
  }

  printExitLogs () {
    if (this.exitLogs.length) {
      this.exitLogs.forEach(({ id, msg, type }) => {
        const shortId = toShortPluginId(id)
        const logFn = logTypes[type]
        if (!logFn) {
          logger.error(`Invalid api.exitLog type '${type}'.`, shortId)
        } else {
          logFn(msg, msg && shortId)
        }
      })
      logger.log()
    }
  }
}
