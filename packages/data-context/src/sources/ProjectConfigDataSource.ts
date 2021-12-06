import { Draft, Immutable, produce, produceWithPatches } from 'immer'
import { defaultsForTestingType, allConfigOptions } from '@packages/config'
import { coerce } from '@packages/config/lib/coerce'
import _ from 'lodash'
import path from 'path'

import type { DataContext } from '..'
import type { CoreDataShape } from '../data'
import type { FoundBrowser, FullConfig, FullConfigBase } from '@packages/types'
import assert from 'assert'

const folders = _(allConfigOptions).filter({ isFolder: true }).map('name').value()

export const CYPRESS_ENV_PREFIX = 'CYPRESS_'

export const CYPRESS_RESERVED_ENV_VARS = [
  'CYPRESS_INTERNAL_ENV',
]

export const CYPRESS_SPECIAL_ENV_VARS = [
  'RECORD_KEY',
]

export interface BuildSetupNodeEventsSources {
  currentTestingType: string | null
  projectConfig: Cypress.ConfigOptionsIpcResponse
  cliConfig: Cypress.ConfigOptions
  machineBrowsers: Array<FoundBrowser>
}

export interface BuildConfigSources extends BuildSetupNodeEventsSources {
  configSetupNodeEvents: Partial<Cypress.ResolvedConfigOptions> | null
}

export class ProjectConfigDataSource {
  // private currentProjectData: CurrentProjectDataShape

  constructor (private ctx: DataContext) {
    // assert(this.ctx.currentProject, `Expected currentProject to be set when calling ctx.projectConfig`)
    // this.currentProjectData = this.ctx.currentProject
  }

  get fullConfig () {
    assert(this.ctx.coreData.derived.fullConfig, `Expected fullConfig to be defined`)

    return this.ctx.coreData.derived.fullConfig
  }

  /**
   * The "Sourced" Config + CLI Config + Env Config all contribute to the values sent to the
   * setupNodeEvents call in the config file. If any of these changed, we need to recompute everything
   */
  shouldRebuildSetupNodeEventsConfig (prevState: Immutable<CoreDataShape>, nextState: Immutable<CoreDataShape>) {
    if (prevState === nextState) {
      return false
    }

    return (
      prevState.currentProject?.currentTestingType !== nextState.currentProject?.currentTestingType ||
      prevState.cliConfig !== nextState.cliConfig ||
      prevState.currentProject?.configFileContents !== nextState.currentProject?.configFileContents ||
      prevState.machineBrowsers !== nextState.machineBrowsers
    )
  }

  /**
   * Whenever we have an Immer update related to config, we compare the keys which form the "full config",
   * and if any of them have changed, we re-compute & store the updated object
   */
  shouldRebuildFullConfig (prevState: Immutable<CoreDataShape>, nextState: Immutable<CoreDataShape>): boolean {
    if (prevState === nextState) {
      return false
    }

    return Boolean(
      this.shouldRebuildSetupNodeEventsConfig(prevState, nextState) ||
      prevState.currentProject?.configSetupNodeEvents !== nextState.currentProject?.configSetupNodeEvents,
    )
  }

  loadedConfig () {
    //
  }

  addRuntimeConfig () {
    return {
      ...this.ctx.coreData,
    }
  }

  /**
   * After we have sourced the config from cypress.config.{js|ts},
   * we combine these options with the options passed in the CLI, the "found browsers", the cypress.env.json
   * and make a Cypress.
   */
  makeSetupNodeEventsConfig (sources: BuildSetupNodeEventsSources) {
    const config = this._setupNodeEventsConfig(sources)

    return config
  }

  buildSetupNodeEventsConfig (configSources: Immutable<BuildConfigSources>) {
    if (!this.ctx.project) {
      return null
    }

    const { config } = this._setupNodeEventsConfig(configSources)

    return config
  }

  /**
   * By this point, all config sources are already pre-sourced & validated,
   * all we need to do is merge them together, and set the overrides as necessary.
   *
   * Using "s" for state, as that's what we use elsewhere when doing ctx.update
   * with immer
   *
   * @param configSources
   * @returns
   */
  buildFullConfig (configSources: Immutable<BuildConfigSources>): FullConfig | null {
    const project = this.ctx.project

    if (!project || Object.values(configSources).some((v) => v === null)) {
      return null
    }

    // const testingType = project.currentTestingType

    // We layer these from bottom to top, which allows us to set the defaults, and then determine
    // what has been overridden at any point in the layering, and pull that out as as ResolvedFromConfig option
    const { config, patches } = this._setupNodeEventsConfig(configSources)

    // 5. Returned from SetupNodeEvents
    const [stateFive, patchesSetupNodeEvents] = produceWithPatches(config, (s) => {
      return s
    })

    // 6. Returned from starting the server
    const [stateSix, patchesSetupServer] = produceWithPatches(stateFive, (s) => {
      return s
    })

    const patchMap = {
      env: patches.patchesEnvJson,
      plugin: patchesSetupNodeEvents,
      config: patches.patchesConfig,
      cli: patches.patchesCLI,
      server: patchesSetupServer,
    }

    return produce(stateSix as FullConfig, (s: FullConfig) => {
      const lastWrite: Record<string, unknown> = {}

      for (const patchSource of ['config', 'env', 'env', 'cli', 'plugin', 'server'] as const) {
        for (const patch of patchMap[patchSource]) {
          lastWrite[String(patch.path)] = {
            value: patch.value,
            from: patchSource,
          }
        }
      }

      s.projectRoot = project.projectRoot
      s.projectName = project.name

      this.normalizeBrowsers(s)
      this.setNodeBinary(s)
      this.setUrls(s)
      this.rewriteLegacyConfig(s)
      this.setAbsolutePaths(s)
      this.injectCtSpecificConfig(s)
      this.hideSpecialVals(s)

      // this.setSupportFileAndFolder()

      // when headless
      if (s.isTextTerminal && !process.env.CYPRESS_INTERNAL_FORCE_FILEWATCH) {
        // dont ever watch for file changes
        s.watchForFileChanges = false
        // and forcibly reset numTestsKeptInMemory to zero
        s.numTestsKeptInMemory = 0
      }

      if (process.env.CYPRESS_INTERNAL_ENV) {
        s.cypressEnv = process.env.CYPRESS_INTERNAL_ENV
      }

      s.resolved = {}

      for (const [key, val] of Object.entries(lastWrite)) {
        _.set(s.resolved, key, val)
      }
    })
  }

  private _setupNodeEventsConfig (sources: Immutable<BuildSetupNodeEventsSources>) {
    const defaultValues = defaultsForTestingType(this.ctx.currentProject?.currentTestingType)

    // 1. Defaults, the base state of the config.
    const stateOne: FullConfigBase = {
      ...defaultValues,
    }

    // 2. Sourced from cypress.config.{js|ts}, merging the "e2e" / "component"
    // keys with the rest of the config, as necessary
    const [stateTwo, patchesConfig] = produceWithPatches(stateOne, (s) => {
      return s
    })

    // 3. Sourced from cypress.env.json, and the process.env
    const [stateThree, patchesEnvJson] = produceWithPatches(stateTwo, (s) => {
      for (const [key, val] of Object.entries(process.env)) {
        if (val === undefined) {
          continue
        }

        if (key.startsWith(CYPRESS_ENV_PREFIX) && key !== 'CYPRESS_INTERNAL_ENV') {
          const toMatch = key.slice(CYPRESS_ENV_PREFIX.length)
          const keyToSet = this.matchesConfigKey(toMatch, defaultValues)

          if (keyToSet) {
            // Not sure why the keyof is giving us a "string", hunch is b/c it's an
            // interface and therefore can be modified elsewhere?
            // @ts-expect-error
            s[keyToSet] = coerce(val)
          } else {
            s.env[key] = coerce(val)
          }
        }
      }

      return s
    })

    const withBrowsers = produce(stateThree, (s) => {
      if (!s.browsers?.length) {
        s.browsers = [...sources.machineBrowsers]
      }

      return s
    })

    // 4. Sourced from CLI - cypress open --browser
    const [stateFour, patchesCLI] = produceWithPatches(withBrowsers, (s) => {
      // this.ctx.coreData.cliConfig

      return s
    })

    return {
      config: stateFour,
      patches: {
        patchesCLI,
        patchesEnvJson,
        patchesConfig,
      },
    }
  }

  private hideSpecialVals (s: Draft<FullConfig>) {
    const recordKey = s.env.RECORD_KEY

    if (recordKey) {
      s.env.RECORD_KEY = [
        recordKey.slice(0, 5),
        recordKey.slice(-5),
      ].join('...')
    }
  }

  private setNodeBinary (s: Draft<FullConfig>) {
    if (this.ctx.coreData.userNodePath) {
      s.resolvedNodePath = this.ctx.coreData.userNodePath
    }

    s.resolvedNodeVersion = this.ctx.coreData.userNodeVersion ?? process.versions.node
  }

  // This value is normally set up in the `packages/server/lib/plugins/index.js#110`
  // But if we don't return it in the plugins function, it never gets set
  // Since there is no chance that it will have any other value here, we set it to "component"
  // This allows users to not return config in the `cypress/plugins/index.js` file
  // https://github.com/cypress-io/cypress/issues/16860
  private injectCtSpecificConfig (s: FullConfig) {
    // TODO: (if: s.currentTestingType)
    if (s) {
      s.viewportHeight ??= 500
      s.viewportWidth ??= 500
    }
  }

  private rewriteLegacyConfig (s: Draft<FullConfig & Record<string, any>>) {
    if (s.visitTimeout) {
      s.pageLoadTimeout = s.visitTimeout
      delete s.visitTimeout
    }

    if (s.commandTimeout) {
      s.defaultCommandTimeout = s.commandTimeout
      delete s.commandTimeout
    }

    // TODO: See how this interacts with the other method
    // if (obj.supportFolder) {
    //   obj.supportFile = obj.supportFolder
    //   delete obj.supportFolder
    // }
  }

  private setUrls (s: Draft<FullConfig>) {
    // replace multiple slashes at the end of string to single slash
    // so http://localhost/// will be http://localhost/
    // https://regexr.com/48rvt
    if (s.baseUrl) {
      s.baseUrl = s.baseUrl.replace(/\/\/+$/, '/')
    }

    // TODO: rename this to be proxyServer
    s.proxyUrl = `http://localhost:${s.port}`
    const rootUrl = s.baseUrl
      ? new URL(s.baseUrl).origin
      : s.proxyUrl

    s.browserUrl = rootUrl + s.clientRoute
    s.reporterUrl = rootUrl + s.reporterRoute
    s.xhrUrl = s.namespace + s.xhrRoute
    s.proxyServer = s.proxyUrl
  }

  private normalizeBrowsers (s: Draft<FullConfig>) {
    for (const browser of s.browsers) {
      if (browser.family !== 'chromium' && s.chromeWebSecurity) {
        browser.warning = this.ctx.errorString('CHROME_WEB_SECURITY_NOT_SUPPORTED', browser.name)
      }

      // if we don't have the isHeaded property
      // then we're in interactive mode and we
      // can assume its a headed browser
      if (!_.has(browser, 'isHeaded')) {
        browser.isHeaded = true
        browser.isHeadless = false
      }
    }
  }

  private setAbsolutePaths (s: Draft<Cypress.Config>) {
    for (const folder of folders) {
      const val = s[folder]

      if (typeof val === 'string' && this.ctx.currentProject?.projectRoot) {
        // @ts-expect-error
        s[folder] = path.isAbsolute(val) ? val : path.resolve(this.ctx.currentProject.projectRoot, val)
      }
    }
  }

  private matchesConfigKey (key: string, defaultValues: Record<string, any>): keyof Cypress.ResolvedConfigOptions | undefined {
    if (_.has(defaultValues, key)) {
      return key as keyof Cypress.ResolvedConfigOptions
    }

    const dashesOrUnderscoresRe = /^(_-)+/

    key = key.toLowerCase().replace(dashesOrUnderscoresRe, '')
    key = _.camelCase(key)

    if (_.has(defaultValues, key)) {
      return key as keyof Cypress.ResolvedConfigOptions
    }

    return undefined
  }

  // TODO: Check this elsewhere
  // private isValidCypressInternalEnvValue (value) {
  //   // names of config environments, see "config/app.yml"
  //   const names = ['development', 'test', 'staging', 'production']
  //   return _.includes(names, value)
  // }

  // private setSupportFileAndFolder (obj, defaults) {
  //   try {
  //     require.resolve(this.ctx.coreData.currentProject)
  //   } catch (e) {
  //     if (e.code === 'MODULE_NOT_FOUND') {
  //       //
  //     }
  //   }

  //   if (!obj.supportFile) {
  //     return Bluebird.resolve(obj)
  //   }

  //   obj = _.clone(obj)

  //   // TODO move this logic to find support file into util/path_helpers
  //   const sf = obj.supportFile

  //   debug(`setting support file ${sf}`)
  //   debug(`for project root ${obj.projectRoot}`)

  //   return Bluebird
  //   .try(() => {
  //     // resolve full path with extension
  //     obj.supportFile = require.resolve(sf)

  //     return debug('resolved support file %s', obj.supportFile)
  //   }).then(() => {
  //     if (!pathHelpers.checkIfResolveChangedRootFolder(obj.supportFile, sf)) {
  //       return
  //     }

  //     debug('require.resolve switched support folder from %s to %s', sf, obj.supportFile)
  //     // this means the path was probably symlinked, like
  //     // /tmp/foo -> /private/tmp/foo
  //     // which can confuse the rest of the code
  //     // switch it back to "normal" file
  //     obj.supportFile = path.join(sf, path.basename(obj.supportFile))

  //     return fs.pathExists(obj.supportFile)
  //     .then((found) => {
  //       if (!found) {
  //         throw this.ctx.error('SUPPORT_FILE_NOT_FOUND', obj.supportFile, obj.configFile || defaults.configFile)
  //       }

  //       return debug('switching to found file %s', obj.supportFile)
  //     })
  //   }).catch({ code: 'MODULE_NOT_FOUND' }, () => {
  //     debug('support JS module %s does not load', sf)

  //     const loadingDefaultSupportFile = sf === path.resolve(obj.projectRoot, defaults.supportFile)

  //     return utils.discoverModuleFile({
  //       filename: sf,
  //       isDefault: loadingDefaultSupportFile,
  //       projectRoot: obj.projectRoot,
  //     })
  //     .then((result) => {
  //       if (result === null) {
  //         const configFile = obj.configFile || defaults.configFile

  //         throw this.ctx.error('SUPPORT_FILE_NOT_FOUND', path.resolve(obj.projectRoot, sf), configFile)
  //       }

  //       debug('setting support file to %o', { result })
  //       obj.supportFile = result

  //       return obj
  //     })
  //   })
  //   .then(() => {
  //     if (obj.supportFile) {
  //       // set config.supportFolder to its directory
  //       obj.supportFolder = path.dirname(obj.supportFile)
  //       debug(`set support folder ${obj.supportFolder}`)
  //     }

  //     return obj
  //   })
  // }

  // private checkIfResolveChangedRootFolder (resolved: string, initial: string) {
  //   return path.isAbsolute(resolved) &&
  //   path.isAbsolute(initial) &&
  //   !resolved.startsWith(initial)
  // }

  // private parseEnv (cfg: Record<string, any>, envCLI: Record<string, any>, resolved: Record<string, any> = {}) {
  //   const envVars = (resolved.env = {})

  //   const resolveFrom = (from, obj = {}) => {
  //     return _.each(obj, (val, key) => {
  //       return envVars[key] = {
  //         value: val,
  //         from,
  //       }
  //     })
  //   }

  //   const envCfg = cfg.env != null ? cfg.env : {}
  //   const envFile = cfg.envFile != null ? cfg.envFile : {}
  //   let envProc = getProcessEnvVars(process.env) || {}

  //   envCLI = envCLI != null ? envCLI : {}

  //   const configFromEnv = _.reduce(envProc, (memo: string[], val, key) => {
  //     let cfgKey: string
  //     return memo
  //   }
  //   , [])

  //   envProc = _.chain(envProc)
  //   .omit(configFromEnv)
  //   .mapValues(this.hideSpecialVals)
  //   .value()

  //   resolveFrom('config', envCfg)
  //   resolveFrom('envFile', envFile)
  //   resolveFrom('env', envProc)
  //   resolveFrom('cli', envCLI)

  //   // envCfg is from cypress.json
  //   // envFile is from cypress.env.json
  //   // envProc is from process env vars
  //   // envCLI is from CLI arguments
  //   return _.extend(envCfg, envFile, envProc, envCLI)
  // }

  // // tries to find support or plugins file
  // // returns:
  // //   false - if the file should not be set
  // //   string - found filename
  // //   null - if there is an error finding the file
  // async discoverModuleFile (supportFile: string) {
  //   debug('discover module file %o', options)
  //   const { filename, isDefault } = options

  //   // they have it explicitly set, so it should be there
  //   if (!isDefault) {
  //     const found = await this.ctx.fs.pathExists(filename)

  //     return found || null
  //   }

  //   // support or plugins file doesn't exist on disk?
  //   debug(`support file is default, check if ${path.dirname(filename)} exists`)

  //   return fs.pathExists(filename)
  //   .then((found) => {
  //     if (found) {
  //       debug('is there index.ts in the support or plugins folder %s?', filename)
  //       const tsFilename = path.join(filename, 'index.ts')

  //       return fs.pathExists(tsFilename)
  //       .then((foundTsFile) => {
  //         if (foundTsFile) {
  //           debug('found index TS file %s', tsFilename)

  //           return tsFilename
  //         }

  //         // if the directory exists, set it to false so it's ignored
  //         debug('setting support or plugins file to false')

  //         return false
  //       })
  //     }

  //     debug('folder does not exist, set to default index.js')

  //     // otherwise, set it up to be scaffolded later
  //     return path.join(filename, 'index.js')
  //   })
  // }
}
