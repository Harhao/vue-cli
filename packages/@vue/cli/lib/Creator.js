const path = require("path");
const debug = require("debug");
const inquirer = require("inquirer");
const EventEmitter = require("events");
// 文件生成和操作类
const Generator = require("./Generator");
// 对preset进行深拷贝
const cloneDeep = require("lodash.clonedeep");
//对数组进行排序处理
const sortObject = require("./util/sortObject");
// 获取@vue/cli的脚手架版本
const getVersions = require("./util/getVersions");
// 创建的包管理工具类，有yarn、pnpm、npm
const PackageManager = require("./util/ProjectPackageManager");
// 清除控制台打印信息
const { clearConsole } = require("./util/clearConsole");
//往creator实例中属性注入feature、prompt、callback、options
const PromptModuleAPI = require("./PromptModuleAPI");
//在targetDir中写入虚拟的文件数据，里面保存的是数据字符串
const writeFileTree = require("./util/writeFileTree");
// 格式化feaure
const { formatFeatures } = require("./util/features");
// 加载本地preset文件
const loadLocalPreset = require("./util/loadLocalPreset");
// 加载远程preset
const loadRemotePreset = require("./util/loadRemotePreset");
// 生成readme.md文件
const generateReadme = require("./util/generateReadme");
// 读取package.json的内容，可以传入工作目录
const { resolvePkg } = require("@vue/cli-shared-utils");
// defaults是默认的preset
// {
// useConfigFiles: false,
// cssPreprocessor: undefined,
// plugins: {
//   '@vue/cli-plugin-babel': {},
//   '@vue/cli-plugin-eslint': {
//     config: 'base',
//     lintOn: ['save']
//   }
// }}
// loadOptions是读取用户根目录的.vuerc里面配置的preset
// saveOptions是剔除不在defaults里面key配置项，然后写入.vuerc
// savePreset是设置保存一个preset
// validatePreset验证preset是否正确
//rcpath是.vuerc路径地址
const {
  defaults,
  saveOptions,
  loadOptions,
  savePreset,
  validatePreset,
  rcPath,
} = require("./options");
// loadModule加载模块
const {
  chalk,
  execa,

  log,
  warn,
  error,
  logWithSpinner,
  stopSpinner,

  hasGit,
  hasProjectGit,
  hasYarn,
  hasPnpm3OrLater,
  hasPnpmVersionOrLater,

  exit,
  loadModule,
} = require("@vue/cli-shared-utils");
// isManualMode是当选择自定义preset时的函数
const isManualMode = (answers) => answers.preset === "__manual__";

module.exports = class Creator extends EventEmitter {
  // name是项目名,context是要创建目录的路径
  constructor(name, context, promptModules) {
    super();

    this.name = name;
    // 将targetDir赋值context
    this.context = process.env.VUE_CLI_CONTEXT = context;
    // 获取preset prompt 和 featurePrompt
    const { presetPrompt, featurePrompt } = this.resolveIntroPrompts();
    // 怎么获取preset的prompt，通过manually、default、自定义获取
    this.presetPrompt = presetPrompt;
    // 选择你所需的功能prompt
    this.featurePrompt = featurePrompt;
    // 获取选择完毕之后的prompt，包括安装依赖的方式、是否保存preset、保存的文件名
    this.outroPrompts = this.resolveOutroPrompts();
    //保存插件中注入的options的prompt
    this.injectedPrompts = [];
    //保存插件中注入的options选择后的毁掉函数
    this.promptCompleteCbs = [];
    this.afterInvokInvokeCbs = [];
    this.afterAnyInvokeCbs = [];

    this.run = this.run.bind(this);
    //往creator实例中属性注入feature、prompt、callback、options
    const promptAPI = new PromptModuleAPI(this);
    //把promptModules中每一个选项注入creator示例的属性featurePrompt、injectedPrompts、onPromptComplete
    promptModules.forEach((m) => m(promptAPI));
  }
  // clioptions是creator.create(options)，options是在命令行输入的参数，经过cleanArgs解析成object类型
  async create(cliOptions = {}, preset = null) {
    const isTestOrDebug = process.env.VUE_CLI_TEST || process.env.VUE_CLI_DEBUG;
    const { run, name, context, afterInvokeCbs, afterAnyInvokeCbs } = this;
    // 如果create函数没有传preset参数
    if (!preset) {
      // clioptions中如果定义preset
      if (cliOptions.preset) {
        // vue create foo --preset bar
        // resolvePreset函数是通过name（bar）获取preset配置
        preset = await this.resolvePreset(cliOptions.preset, cliOptions.clone);
      } else if (cliOptions.default) {
        // vue create foo --default
        //如果指定--default,则取默认的配置，
        preset = defaults.presets.default;
      } else if (cliOptions.inlinePreset) {
        // vue create foo --inlinePreset {...}
        // 通过json字符串指定preset
        try {
          preset = JSON.parse(cliOptions.inlinePreset);
        } catch (e) {
          error(
            `CLI inline preset is not valid JSON: ${cliOptions.inlinePreset}`
          );
          exit(1);
        }
      } else {
        //如果没有在命令行指定preset参数，通过询问的方式获取preset
        preset = await this.promptAndResolvePreset();
      }
    }

    // clone before mutating
    // 在preset改变之前 深拷贝一份preset
    preset = cloneDeep(preset);
    // inject core service
    // 注入@vue/cli-service插件
    preset.plugins["@vue/cli-service"] = Object.assign(
      {
        projectName: name,
      },
      preset
    );
    //  创建项目时省略默认组件中的新手指导信息
    if (cliOptions.bare) {
      preset.plugins["@vue/cli-service"].bare = true;
    }

    // legacy support for router
    // 注入cli-plugin-router插件
    if (preset.router) {
      preset.plugins["@vue/cli-plugin-router"] = {};

      if (preset.routerHistoryMode) {
        preset.plugins["@vue/cli-plugin-router"].historyMode = true;
      }
    }

    // legacy support for vuex
    // // 注入cli-plugin-vuex插件
    if (preset.vuex) {
      preset.plugins["@vue/cli-plugin-vuex"] = {};
    }
    // packageManager是传递进安装依赖的工具，询问选择的方式，preset中的方式，还是电脑中存在的工具
    const packageManager =
      cliOptions.packageManager ||
      loadOptions().packageManager ||
      (hasYarn() ? "yarn" : null) ||
      (hasPnpm3OrLater() ? "pnpm" : "npm");
    // 创建一个可以安装依赖的示例，里面封装安装依赖的方法
    const pm = new PackageManager({
      context,
      forcePackageManager: packageManager,
    });
    // 清除命令行
    await clearConsole();
    // 打印安装创建项目提示信息
    logWithSpinner(`✨`, `Creating project in ${chalk.yellow(context)}.`);
    // 这里的触发vue UI的事件
    this.emit("creation", { event: "creating" });

    // get latest CLI plugin version
    // 获取最新cli 插件的版本
    const { latestMinor } = await getVersions();

    // generate package.json with plugin dependencies
    // 生成带有开发插件依赖的package.json文件
    const pkg = {
      name,
      version: "0.1.0",
      private: true,
      devDependencies: {},
      ...resolvePkg(context),
    };
    const deps = Object.keys(preset.plugins);
    deps.forEach((dep) => {
      if (preset.plugins[dep]._isPreset) {
        return;
      }

      // Note: the default creator includes no more than `@vue/cli-*` & `@vue/babel-preset-env`,
      // so it is fine to only test `@vue` prefix.
      // Other `@vue/*` packages' version may not be in sync with the cli itself.
      pkg.devDependencies[dep] =
        preset.plugins[dep].version ||
        (/^@vue/.test(dep) ? `~${latestMinor}` : `latest`);
    });

    // write package.json
    await writeFileTree(context, {
      "package.json": JSON.stringify(pkg, null, 2),
    });

    // intilaize git repository before installing deps
    // so that vue-cli-service can setup git hooks.
    const shouldInitGit = this.shouldInitGit(cliOptions);
    if (shouldInitGit) {
      logWithSpinner(`🗃`, `Initializing git repository...`);
      this.emit("creation", { event: "git-init" });
      await run("git init");
    }

    // install plugins
    stopSpinner();
    log(`⚙\u{fe0f}  Installing CLI plugins. This might take a while...`);
    log();
    this.emit("creation", { event: "plugins-install" });

    if (isTestOrDebug && !process.env.VUE_CLI_TEST_DO_INSTALL_PLUGIN) {
      // in development, avoid installation process
      await require("./util/setupDevProject")(context);
    } else {
      // await pm.install();
    }

    // run generator
    log(`🚀  Invoking generators...`);
    this.emit("creation", { event: "invoking-generators" });
    const plugins = await this.resolvePlugins(preset.plugins);
    const generator = new Generator(context, {
      pkg,
      plugins,
      afterInvokeCbs,
      afterAnyInvokeCbs,
    });
    await generator.generate({
      extractConfigFiles: preset.useConfigFiles,
    });

    // install additional deps (injected by generators)
    log(`📦  Installing additional dependencies...`);
    this.emit("creation", { event: "deps-install" });
    log();
    if (!isTestOrDebug) {
      // await pm.install();
    }

    // run complete cbs if any (injected by generators)
    logWithSpinner("⚓", `Running completion hooks...`);
    this.emit("creation", { event: "completion-hooks" });
    for (const cb of afterInvokeCbs) {
      await cb();
    }
    for (const cb of afterAnyInvokeCbs) {
      await cb();
    }

    // generate README.md
    stopSpinner();
    log();
    logWithSpinner("📄", "Generating README.md...");
    await writeFileTree(context, {
      "README.md": generateReadme(generator.pkg, packageManager),
    });

    // generate a .npmrc file for pnpm, to persist the `shamefully-flatten` flag
    if (packageManager === "pnpm") {
      const pnpmConfig = hasPnpmVersionOrLater("4.0.0")
        ? "shamefully-hoist=true\n"
        : "shamefully-flatten=true\n";

      await writeFileTree(context, {
        ".npmrc": pnpmConfig,
      });
    }

    // commit initial state
    let gitCommitFailed = false;
    if (shouldInitGit) {
      await run("git add -A");
      if (isTestOrDebug) {
        await run("git", ["config", "user.name", "test"]);
        await run("git", ["config", "user.email", "test@test.com"]);
      }
      const msg = typeof cliOptions.git === "string" ? cliOptions.git : "init";
      try {
        await run("git", ["commit", "-m", msg]);
      } catch (e) {
        gitCommitFailed = true;
      }
    }

    // log instructions
    stopSpinner();
    log();
    log(`🎉  Successfully created project ${chalk.yellow(name)}.`);
    if (!cliOptions.skipGetStarted) {
      log(
        `👉  Get started with the following commands:\n\n` +
          (this.context === process.cwd()
            ? ``
            : chalk.cyan(` ${chalk.gray("$")} cd ${name}\n`)) +
          chalk.cyan(
            ` ${chalk.gray("$")} ${
              packageManager === "yarn"
                ? "yarn serve"
                : packageManager === "pnpm"
                ? "pnpm run serve"
                : "npm run serve"
            }`
          )
      );
    }
    log();
    this.emit("creation", { event: "done" });

    if (gitCommitFailed) {
      warn(
        `Skipped git commit due to missing username and email in git config.\n` +
          `You will need to perform the initial commit yourself.\n`
      );
    }

    generator.printExitLogs();
  }

  run(command, args) {
    if (!args) {
      [command, ...args] = command.split(/\s+/);
    }
    //创建一个子进程,在目标目录运行shell命令,args是配置参数，command是命令
    return execa(command, args, { cwd: this.context });
  }

  async promptAndResolvePreset(answers = null) {
    // prompt
    if (!answers) {
      await clearConsole(true);
      answers = await inquirer.prompt(this.resolveFinalPrompts());
    }
    debug("vue-cli:answers")(answers);

    if (answers.packageManager) {
      saveOptions({
        packageManager: answers.packageManager,
      });
    }

    let preset;
    if (answers.preset && answers.preset !== "__manual__") {
      preset = await this.resolvePreset(answers.preset);
    } else {
      // manual
      preset = {
        useConfigFiles: answers.useConfigFiles === "files",
        plugins: {},
      };
      answers.features = answers.features || [];
      // run cb registered by prompt modules to finalize the preset
      this.promptCompleteCbs.forEach((cb) => cb(answers, preset));
    }

    // validate
    validatePreset(preset);

    // save preset
    if (
      answers.save &&
      answers.saveName &&
      savePreset(answers.saveName, preset)
    ) {
      log();
      log(
        `🎉  Preset ${chalk.yellow(answers.saveName)} saved in ${chalk.yellow(
          rcPath
        )}`
      );
    }

    debug("vue-cli:preset")(preset);
    return preset;
  }

  async resolvePreset(name, clone) {
    let preset;
    const savedPresets = loadOptions().presets || {};

    if (name in savedPresets) {
      preset = savedPresets[name];
    } else if (
      name.endsWith(".json") ||
      /^\./.test(name) ||
      path.isAbsolute(name)
    ) {
      preset = await loadLocalPreset(path.resolve(name));
    } else if (name.includes("/")) {
      logWithSpinner(`Fetching remote preset ${chalk.cyan(name)}...`);
      this.emit("creation", { event: "fetch-remote-preset" });
      try {
        preset = await loadRemotePreset(name, clone);
        stopSpinner();
      } catch (e) {
        stopSpinner();
        error(`Failed fetching remote preset ${chalk.cyan(name)}:`);
        throw e;
      }
    }

    // use default preset if user has not overwritten it
    if (name === "default" && !preset) {
      preset = defaults.presets.default;
    }
    if (!preset) {
      error(`preset "${name}" not found.`);
      const presets = Object.keys(savedPresets);
      if (presets.length) {
        log();
        log(`available presets:\n${presets.join(`\n`)}`);
      } else {
        log(`you don't seem to have any saved preset.`);
        log(`run vue-cli in manual mode to create a preset.`);
      }
      exit(1);
    }
    return preset;
  }
  /**
   * 
   * @param  rawPlugins 
   * {"preset": {
      "useConfigFiles": false,
      "plugins": {
        "@vue/cli-plugin-babel": {},
        "@vue/cli-plugin-typescript": {
          "classComponent": true,
          "useTsWithBabel": true
        },
        "@vue/cli-plugin-pwa": {},
        "@vue/cli-plugin-router": {
          "historyMode": true
        },
        "@vue/cli-plugin-vuex": {},
        "@vue/cli-plugin-eslint": {
          "config": "airbnb",
          "lintOn": [
            "save"
          ]
        }
      },
      "cssPreprocessor": "dart-sass"
    }}
   */
  // { id: options } => [{ id, apply, options }]
  async resolvePlugins(rawPlugins) {
    // ensure cli-service is invoked first
    rawPlugins = sortObject(rawPlugins, ["@vue/cli-service"], true);
    const plugins = [];
    for (const id of Object.keys(rawPlugins)) {
      // 获取插件内部的generator绝对路径地址
      const apply = loadModule(`${id}/generator`, this.context) || (() => {});
      let options = rawPlugins[id] || {};
      if (options.prompts) {
        // 获取插件里面定义的prompt的路径地址
        const prompts = loadModule(`${id}/prompts`, this.context);
        if (prompts) {
          log();
          log(`${chalk.cyan(options._isPreset ? `Preset options:` : id)}`);
          options = await inquirer.prompt(prompts);
        }
      }
      plugins.push({ id, apply, options });
    }
    // eg: plugins item : { id: '@vue/cli-plugin-router',options: {"historyMode": true},apply: 'C:\Users\admin\Desktop\vue-cli\cli-plugin-babel\generator.js'}
    return plugins;
  }

  getPresets() {
    // 加载本地~vuerc的preset配置信息
    const savedOptions = loadOptions();
    //合并本地保存的preset配置和默认的babel,eslint配置信息
    return Object.assign({}, savedOptions.presets, defaults.presets);
  }
  // 返回preset Select prompt
  resolveIntroPrompts() {
    // 返回preset的配置数据
    const presets = this.getPresets();
    //获取presets选项信息
    const presetChoices = Object.keys(presets).map((name) => {
      return {
        name: `${name} (${formatFeatures(presets[name])})`,
        value: name,
      };
    });
    //获取presets选项信息prompt
    const presetPrompt = {
      name: "preset",
      type: "list",
      message: `Please pick a preset:`,
      choices: [
        ...presetChoices,
        {
          name: "Manually select features",
          value: "__manual__",
        },
      ],
    };
    // 功能prompt列表选择
    const featurePrompt = {
      name: "features",
      when: isManualMode,
      type: "checkbox",
      message: "Check the features needed for your project:",
      choices: [],
      pageSize: 10,
    };
    return {
      presetPrompt,
      featurePrompt,
    };
  }

  resolveOutroPrompts() {
    const outroPrompts = [
      {
        name: "useConfigFiles",
        when: isManualMode,
        type: "list",
        message: "Where do you prefer placing config for Babel, ESLint, etc.?",
        choices: [
          {
            name: "In dedicated config files",
            value: "files",
          },
          {
            name: "In package.json",
            value: "pkg",
          },
        ],
      },
      {
        name: "save",
        when: isManualMode,
        type: "confirm",
        message: "Save this as a preset for future projects?",
        default: false,
      },
      {
        name: "saveName",
        when: (answers) => answers.save,
        type: "input",
        message: "Save preset as:",
      },
    ];

    // ask for packageManager once
    const savedOptions = loadOptions();
    if (!savedOptions.packageManager && (hasYarn() || hasPnpm3OrLater())) {
      const packageManagerChoices = [];

      if (hasYarn()) {
        packageManagerChoices.push({
          name: "Use Yarn",
          value: "yarn",
          short: "Yarn",
        });
      }

      if (hasPnpm3OrLater()) {
        packageManagerChoices.push({
          name: "Use PNPM",
          value: "pnpm",
          short: "PNPM",
        });
      }

      packageManagerChoices.push({
        name: "Use NPM",
        value: "npm",
        short: "NPM",
      });

      outroPrompts.push({
        name: "packageManager",
        type: "list",
        message:
          "Pick the package manager to use when installing dependencies:",
        choices: packageManagerChoices,
      });
    }

    return outroPrompts;
  }

  resolveFinalPrompts() {
    // patch generator-injected prompts to only show in manual mode
    this.injectedPrompts.forEach((prompt) => {
      const originalWhen = prompt.when || (() => true);
      prompt.when = (answers) => {
        return isManualMode(answers) && originalWhen(answers);
      };
    });
    const prompts = [
      this.presetPrompt,
      this.featurePrompt,
      ...this.injectedPrompts,
      ...this.outroPrompts,
    ];
    debug("vue-cli:prompts")(prompts);
    return prompts;
  }

  shouldInitGit(cliOptions) {
    if (!hasGit()) {
      return false;
    }
    // --git
    if (cliOptions.forceGit) {
      return true;
    }
    // --no-git
    if (cliOptions.git === false || cliOptions.git === "false") {
      return false;
    }
    // default: true unless already in a git repo
    return !hasProjectGit(this.context);
  }
};
