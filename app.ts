// Copyright (c) 2012, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

////
// see https://docs.sentry.io/platforms/javascript/guides/node/install/late-initialization/
import '@sentry/node/preload'; // preload Sentry's "preload" support before any other imports
////
import child_process from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import * as Sentry from '@sentry/node';
import {Command, OptionValues} from 'commander';
import compression from 'compression';
import express from 'express';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import morgan from 'morgan';
import PromClient from 'prom-client';
import responseTime from 'response-time';
import sanitize from 'sanitize-filename';
import sFavicon from 'serve-favicon';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import systemdSocket from 'systemd-socket';
import _ from 'underscore';
import urljoin from 'url-join';

import {AppArguments} from './lib/app.interfaces.js';
import {setBaseDirectory, unwrap} from './lib/assert.js';
import * as aws from './lib/aws.js';
import * as normalizer from './lib/clientstate-normalizer.js';
import {GoldenLayoutRootStruct} from './lib/clientstate-normalizer.js';
import {CompilationEnvironment} from './lib/compilation-env.js';
import {CompilationQueue} from './lib/compilation-queue.js';
import {CompilerFinder} from './lib/compiler-finder.js';
import {startWineInit} from './lib/exec.js';
import {RemoteExecutionQuery} from './lib/execution/execution-query.js';
import {initHostSpecialties} from './lib/execution/execution-triple.js';
import {startExecutionWorkerThread} from './lib/execution/sqs-execution-queue.js';
import {FormattingService} from './lib/formatting-service.js';
import {AssemblyDocumentationController} from './lib/handlers/api/assembly-documentation-controller.js';
import {FormattingController} from './lib/handlers/api/formatting-controller.js';
import {HealthcheckController} from './lib/handlers/api/healthcheck-controller.js';
import {NoScriptController} from './lib/handlers/api/noscript-controller.js';
import {SiteTemplateController} from './lib/handlers/api/site-template-controller.js';
import {SourceController} from './lib/handlers/api/source-controller.js';
import {CompileHandler} from './lib/handlers/compile.js';
import {ShortLinkMetaData} from './lib/handlers/handler.interfaces.js';
import {cached, createFormDataHandler, csp} from './lib/handlers/middleware.js';
import {NoScriptHandler} from './lib/handlers/noscript.js';
import {RouteAPI} from './lib/handlers/route-api.js';
import {languages as allLanguages} from './lib/languages.js';
import {logToLoki, logToPapertrail, logger, makeLogStream, suppressConsoleLog} from './lib/logger.js';
import {setupMetricsServer} from './lib/metrics-server.js';
import {ClientOptionsHandler} from './lib/options-handler.js';
import * as props from './lib/properties.js';
import {SetupSentry} from './lib/sentry.js';
import {ShortLinkResolver} from './lib/shortener/google.js';
import {sources} from './lib/sources/index.js';
import {loadSponsorsFromString} from './lib/sponsors.js';
import {getStorageTypeByKey} from './lib/storage/index.js';
import * as utils from './lib/utils.js';
import {ElementType} from './shared/common-utils.js';
import {CompilerInfo} from './types/compiler.interfaces.js';
import type {Language, LanguageKey} from './types/languages.interfaces.js';

setBaseDirectory(new URL('.', import.meta.url));

function parseNumberForOptions(value: string): number {
    const parsedValue = Number.parseInt(value, 10);
    if (Number.isNaN(parsedValue)) {
        throw new Error(`Invalid number: "${value}"`);
    }
    return parsedValue;
}

interface CompilerExplorerOptions extends OptionValues {
    env: string[];
    rootDir: string;
    host?: string;
    port: number;
    propDebug?: boolean;
    debug?: boolean;
    dist?: boolean;
    remoteFetch: boolean;
    tmpDir?: string;
    wsl?: boolean;
    language?: string[];
    cache: boolean;
    ensureNoIdClash?: boolean;
    logHost?: string;
    logPort?: number;
    hostnameForLogging?: string;
    suppressConsoleLog: boolean;
    metricsPort?: number;
    loki?: string;
    discoveryOnly?: string;
    prediscovered?: string;
    static?: string;
    local: boolean;
    version: boolean;
}

const program = new Command();
program
    .name('compiler-explorer')
    .description('Interactively investigate compiler output')
    .option('--env <environments...>', 'Environment(s) to use', ['dev'])
    .option('--root-dir <dir>', 'Root directory for config files', './etc')
    .option('--host <hostname>', 'Hostname to listen on')
    .option('--port <port>', 'Port to listen on', parseNumberForOptions, 10240)
    .option('--prop-debug', 'Debug properties')
    .option('--debug', 'Enable debug output')
    .option('--dist', 'Running in dist mode')
    .option('--no-remote-fetch', 'Ignore fetch marks and assume every compiler is found locally')
    .option('--tmpDir, --tmp-dir <dir>', 'Directory to use for temporary files')
    .option('--wsl', 'Running under Windows Subsystem for Linux')
    .option('--language <languages...>', 'Only load specified languages for faster startup')
    .option('--no-cache', 'Do not use caching for compilation results')
    .option('--ensure-no-id-clash', "Don't run if compilers have clashing ids")
    .option('--logHost, --log-host <hostname>', 'Hostname for remote logging')
    .option('--logPort, --log-port <port>', 'Port for remote logging', parseNumberForOptions)
    .option('--hostnameForLogging, --hostname-for-logging <hostname>', 'Hostname to use in logs')
    .option('--suppressConsoleLog, --suppress-console-log', 'Disable console logging')
    .option('--metricsPort, --metrics-port <port>', 'Port to serve metrics on', parseNumberForOptions)
    .option('--loki <url>', 'URL for Loki logging')
    .option('--discoveryonly, --discovery-only <file>', 'Output discovery info to file and exit')
    .option('--prediscovered <file>', 'Input discovery info from file')
    .option('--static <dir>', 'Path to static content')
    .option('--no-local', 'Disable local config')
    .option('--version', 'Show version information');

program.parse();

const opts = program.opts<CompilerExplorerOptions>();

if (opts.debug) logger.level = 'debug';

// AP: Detect if we're running under Windows Subsystem for Linux. Temporary modification
// of process.env is allowed: https://nodejs.org/api/process.html#process_process_env
if (process.platform === 'linux' && child_process.execSync('uname -a').toString().toLowerCase().includes('microsoft')) {
    // Node wants process.env is essentially a Record<key, string | undefined>. Any non-empty string should be fine.
    process.env.wsl = 'true';
}

// Allow setting of the temporary directory (that which `os.tmpdir()` returns).
// WSL requires a directory on a Windows volume. Set that to Windows %TEMP% if no -tmpDir supplied.
// If a tempDir is supplied then assume that it will work for WSL processes as well.
if (opts.tmpDir) {
    if (process.env.wsl) {
        process.env.TEMP = opts.tmpDir; // for Windows
    } else {
        process.env.TMP = opts.tmpDir; // for Linux
    }
    if (os.tmpdir() !== opts.tmpDir)
        throw new Error(`Unable to set the temporary dir to ${opts.tmpDir} - stuck at  ${os.tmpdir()}`);
} else if (process.env.wsl) {
    // Dec 2017 preview builds of WSL include /bin/wslpath; do the parsing work for now.
    // Parsing example %TEMP% is C:\Users\apardoe\AppData\Local\Temp
    try {
        const windowsTemp = child_process.execSync('cmd.exe /c echo %TEMP%').toString().replaceAll('\\', '/');
        const driveLetter = windowsTemp.substring(0, 1).toLowerCase();
        const directoryPath = windowsTemp.substring(2).trim();
        process.env.TEMP = path.join('/mnt', driveLetter, directoryPath);
    } catch (e) {
        logger.warn('Unable to invoke cmd.exe to get windows %TEMP% path.');
    }
}
logger.info(`Using temporary dir: ${os.tmpdir()}`);

const distPath = utils.resolvePathFromAppRoot('.');
logger.debug(`Distpath=${distPath}`);

const gitReleaseName = (() => {
    // Use the canned git_hash if provided
    const gitHashFilePath = path.join(distPath, 'git_hash');
    if (opts.dist && fsSync.existsSync(gitHashFilePath)) {
        return fsSync.readFileSync(gitHashFilePath).toString().trim();
    }

    // Just if we have been cloned and not downloaded (Thanks David!)
    if (fsSync.existsSync('.git/')) {
        return child_process.execSync('git rev-parse HEAD').toString().trim();
    }

    // unknown case
    return '';
})();

const releaseBuildNumber = (() => {
    // Use the canned build only if provided
    const releaseBuildPath = path.join(distPath, 'release_build');
    if (opts.dist && fsSync.existsSync(releaseBuildPath)) {
        return fsSync.readFileSync(releaseBuildPath).toString().trim();
    }
    return '';
})();

// TODO: only used in the windows run.ps1 - remove this once that's gone!
function patchUpLanguageArg(languages: string[] | undefined): string[] | undefined {
    if (!languages) return undefined;
    if (languages.length === 1) {
        // Support old style comma-separated language args.
        return languages[0].split(',');
    }
    return languages;
}

const appArgs: AppArguments = {
    rootDir: opts.rootDir,
    env: opts.env,
    hostname: opts.host,
    port: opts.port,
    gitReleaseName: gitReleaseName,
    releaseBuildNumber: releaseBuildNumber,
    wantedLanguages: patchUpLanguageArg(opts.language),
    doCache: opts.cache,
    fetchCompilersFromRemote: opts.remoteFetch,
    ensureNoCompilerClash: opts.ensureNoIdClash,
    suppressConsoleLog: opts.suppressConsoleLog,
};

if (opts.logHost && opts.logPort) {
    logToPapertrail(opts.logHost, opts.logPort, appArgs.env.join('.'), opts.hostnameForLogging);
}

if (opts.loki) {
    logToLoki(opts.loki);
}

if (appArgs.suppressConsoleLog) {
    logger.info('Disabling further console logging');
    suppressConsoleLog();
}

const isDevMode = () => process.env.NODE_ENV !== 'production';

function getFaviconFilename() {
    if (isDevMode()) {
        return 'favicon-dev.ico';
    }
    if (opts.env?.includes('beta')) {
        return 'favicon-beta.ico';
    }
    if (opts.env?.includes('staging')) {
        return 'favicon-staging.ico';
    }
    return 'favicon.ico';
}

const propHierarchy = [
    'defaults',
    appArgs.env,
    appArgs.env.map(e => `${e}.${process.platform}`),
    process.platform,
    os.hostname(),
].flat();
if (opts.local) {
    propHierarchy.push('local');
}
logger.info(`properties hierarchy: ${propHierarchy.join(', ')}`);

// Propagate debug mode if need be
if (opts.propDebug) props.setDebug(true);

// *All* files in config dir are parsed
const configDir = path.join(appArgs.rootDir, 'config');
props.initialize(configDir, propHierarchy);
// Instantiate a function to access records concerning "compiler-explorer"
// in hidden object props.properties
const ceProps = props.propsFor('compiler-explorer');
const restrictToLanguages = ceProps<string>('restrictToLanguages');
if (restrictToLanguages) {
    appArgs.wantedLanguages = restrictToLanguages.split(',');
}

const languages = (() => {
    if (appArgs.wantedLanguages) {
        const filteredLangs: Partial<Record<LanguageKey, Language>> = {};
        for (const wantedLang of appArgs.wantedLanguages) {
            for (const lang of Object.values(allLanguages)) {
                if (lang.id === wantedLang || lang.name === wantedLang || lang.alias.includes(wantedLang)) {
                    filteredLangs[lang.id] = lang;
                }
            }
        }
        // Always keep cmake for IDE mode, just in case
        filteredLangs[allLanguages.cmake.id] = allLanguages.cmake;
        return filteredLangs;
    }
    return allLanguages;
})();

if (Object.keys(languages).length === 0) {
    logger.error('Trying to start Compiler Explorer without a language');
}

const compilerProps = new props.CompilerProps(languages, ceProps);

const staticPath = opts.static || path.join(distPath, 'static');
const staticMaxAgeSecs = ceProps('staticMaxAgeSecs', 0);
const maxUploadSize = ceProps('maxUploadSize', '1mb');
const extraBodyClass = ceProps('extraBodyClass', isDevMode() ? 'dev' : '');
const storageSolution = compilerProps.ceProps('storageSolution', 'local');
const httpRoot = urljoin(ceProps('httpRoot', '/'), '/');

const staticUrl = ceProps<string | undefined>('staticUrl');
const staticRoot = urljoin(staticUrl || urljoin(httpRoot, 'static'), '/');

function measureEventLoopLag(delayMs: number) {
    return new Promise<number>(resolve => {
        const start = process.hrtime.bigint();
        setTimeout(() => {
            const elapsed = process.hrtime.bigint() - start;
            const delta = elapsed - BigInt(delayMs * 1000000);
            return resolve(Number(delta) / 1000000);
        }, delayMs);
    });
}

function setupEventLoopLagLogging() {
    const lagIntervalMs = ceProps('eventLoopMeasureIntervalMs', 0);
    const thresWarn = ceProps('eventLoopLagThresholdWarn', 0);
    const thresErr = ceProps('eventLoopLagThresholdErr', 0);

    let totalLag = 0;
    const ceLagSecondsTotalGauge = new PromClient.Gauge({
        name: 'ce_lag_seconds_total',
        help: 'Total event loop lag since application startup',
    });

    async function eventLoopLagHandler() {
        const lagMs = await measureEventLoopLag(lagIntervalMs);
        totalLag += Math.max(lagMs / 1000, 0);
        ceLagSecondsTotalGauge.set(totalLag);

        if (thresErr && lagMs >= thresErr) {
            logger.error(`Event Loop Lag: ${lagMs} ms`);
        } else if (thresWarn && lagMs >= thresWarn) {
            logger.warn(`Event Loop Lag: ${lagMs} ms`);
        }

        setImmediate(eventLoopLagHandler);
    }

    if (lagIntervalMs > 0) {
        setImmediate(eventLoopLagHandler);
    }
}

let pugRequireHandler: (path: string) => any = () => {
    logger.error('pug require handler not configured');
};

async function setupWebPackDevMiddleware(router: express.Router) {
    logger.info('  using webpack dev middleware');

    /* eslint-disable n/no-unpublished-import,import/extensions, */
    const {default: webpackDevMiddleware} = await import('webpack-dev-middleware');
    const {default: webpackConfig} = await import('./webpack.config.esm.js');
    const {default: webpack} = await import('webpack');
    /* eslint-enable */
    type WebpackConfiguration = ElementType<Parameters<typeof webpack>[0]>;

    const webpackCompiler = webpack([webpackConfig as WebpackConfiguration]);
    router.use(
        webpackDevMiddleware(webpackCompiler, {
            publicPath: '/static',
            stats: {
                preset: 'errors-only',
                timings: true,
            },
        }),
    );

    pugRequireHandler = path => urljoin(httpRoot, 'static', path);
}

async function setupStaticMiddleware(router: express.Router) {
    const staticManifest = JSON.parse(await fs.readFile(path.join(distPath, 'manifest.json'), 'utf-8'));

    if (staticUrl) {
        logger.info(`  using static files from '${staticUrl}'`);
    } else {
        logger.info(`  serving static files from '${staticPath}'`);
        router.use(
            '/static',
            express.static(staticPath, {
                maxAge: staticMaxAgeSecs * 1000,
            }),
        );
    }

    pugRequireHandler = path => {
        if (Object.prototype.hasOwnProperty.call(staticManifest, path)) {
            return urljoin(staticRoot, staticManifest[path]);
        }
        logger.error(`failed to locate static asset '${path}' in manifest`);
        return '';
    };
}

const googleShortUrlResolver = new ShortLinkResolver();

function oldGoogleUrlHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
    const id = req.params.id;
    const googleUrl = `https://goo.gl/${encodeURIComponent(id)}`;
    googleShortUrlResolver
        .resolve(googleUrl)
        .then(resultObj => {
            const parsed = new url.URL(resultObj.longUrl);
            const allowedRe = new RegExp(ceProps<string>('allowedShortUrlHostRe'));
            if (parsed.host.match(allowedRe) === null) {
                logger.warn(`Denied access to short URL ${id} - linked to ${resultObj.longUrl}`);
                return next({
                    statusCode: 404,
                    message: `ID "${id}" could not be found`,
                });
            }
            res.writeHead(301, {
                Location: resultObj.longUrl,
                'Cache-Control': 'public',
            });
            res.end();
        })
        .catch(e => {
            logger.error(`Failed to expand ${googleUrl} - ${e}`);
            next({
                statusCode: 404,
                message: `ID "${id}" could not be found`,
            });
        });
}

function startListening(server: express.Express) {
    const ss: {fd: number} | null = systemdSocket(); // TODO: I'm not sure this works any more
    if (ss) {
        // ms (5 min default)
        const idleTimeout = process.env.IDLE_TIMEOUT;
        const timeout = (idleTimeout === undefined ? 300 : Number.parseInt(idleTimeout)) * 1000;
        if (idleTimeout) {
            const exit = () => {
                logger.info('Inactivity timeout reached, exiting.');
                process.exit(0);
            };
            let idleTimer = setTimeout(exit, timeout);
            const reset = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(exit, timeout);
            };
            server.all('*', reset);
            logger.info(`  IDLE_TIMEOUT: ${idleTimeout}`);
        }
        logger.info(`  Listening on systemd socket: ${JSON.stringify(ss)}`);
        server.listen(ss);
    } else {
        logger.info(`  Listening on http://${appArgs.hostname || 'localhost'}:${appArgs.port}/`);
        if (appArgs.hostname) {
            server.listen(appArgs.port, appArgs.hostname);
        } else {
            server.listen(appArgs.port);
        }
    }

    const startupGauge = new PromClient.Gauge({
        name: 'ce_startup_seconds',
        help: 'Time taken from process start to serving requests',
    });
    startupGauge.set(process.uptime());
    const startupDurationMs = Math.floor(process.uptime() * 1000);
    logger.info(`  Startup duration: ${startupDurationMs}ms`);
    logger.info('=======================================');
}

const awsProps = props.propsFor('aws');

// eslint-disable-next-line max-statements
async function main() {
    await aws.initConfig(awsProps);
    SetupSentry(aws.getConfig('sentryDsn'), ceProps, releaseBuildNumber, gitReleaseName, appArgs);
    const webServer = express();
    const router = express.Router();

    startWineInit();

    RemoteExecutionQuery.initRemoteExecutionArchs(ceProps, appArgs.env);

    const formattingService = new FormattingService();
    await formattingService.initialize(ceProps);

    const clientOptionsHandler = new ClientOptionsHandler(sources, compilerProps, appArgs);
    const compilationQueue = CompilationQueue.fromProps(compilerProps.ceProps);
    const compilationEnvironment = new CompilationEnvironment(
        compilerProps,
        awsProps,
        compilationQueue,
        formattingService,
        appArgs.doCache,
    );
    const compileHandler = new CompileHandler(compilationEnvironment, awsProps);
    compilationEnvironment.setCompilerFinder(compileHandler.findCompiler.bind(compileHandler));
    const storageType = getStorageTypeByKey(storageSolution);
    const storageHandler = new storageType(httpRoot, compilerProps, awsProps);
    const compilerFinder = new CompilerFinder(compileHandler, compilerProps, appArgs, clientOptionsHandler);

    const isExecutionWorker = ceProps<boolean>('execqueue.is_worker', false);
    const healthCheckFilePath = ceProps('healthCheckFilePath', null) as string | null;
    const formDataHandler = createFormDataHandler();

    const siteTemplateController = new SiteTemplateController();
    const sourceController = new SourceController(sources);
    const assemblyDocumentationController = new AssemblyDocumentationController();
    const healthCheckController = new HealthcheckController(
        compilationQueue,
        healthCheckFilePath,
        compileHandler,
        isExecutionWorker,
    );
    const formattingController = new FormattingController(formattingService);
    const noScriptController = new NoScriptController(compileHandler, formDataHandler);

    logger.info('=======================================');
    if (gitReleaseName) logger.info(`  git release ${gitReleaseName}`);
    if (releaseBuildNumber) logger.info(`  release build ${releaseBuildNumber}`);

    let initialCompilers: CompilerInfo[];
    let prevCompilers: CompilerInfo[];

    if (opts.prediscovered) {
        const prediscoveredCompilersJson = await fs.readFile(opts.prediscovered, 'utf8');
        initialCompilers = JSON.parse(prediscoveredCompilersJson);
        const prediscResult = await compilerFinder.loadPrediscovered(initialCompilers);
        if (prediscResult.length === 0) {
            throw new Error('Unexpected failure, no compilers found!');
        }
    } else {
        const initialFindResults = await compilerFinder.find();
        initialCompilers = initialFindResults.compilers;
        if (!isExecutionWorker && initialCompilers.length === 0) {
            throw new Error('Unexpected failure, no compilers found!');
        }
        if (appArgs.ensureNoCompilerClash) {
            logger.warn('Ensuring no compiler ids clash');
            if (initialFindResults.foundClash) {
                // If we are forced to have no clashes, throw an error with some explanation
                throw new Error('Clashing compilers in the current environment found!');
            }
            logger.info('No clashing ids found, continuing normally...');
        }
    }

    if (opts.discoveryOnly) {
        for (const compiler of initialCompilers) {
            if (compiler.buildenvsetup && compiler.buildenvsetup.id === '') delete compiler.buildenvsetup;

            if (compiler.externalparser && compiler.externalparser.id === '') delete compiler.externalparser;

            const compilerInstance = compilerFinder.compileHandler.findCompiler(compiler.lang, compiler.id);
            if (compilerInstance) {
                compiler.cachedPossibleArguments = compilerInstance.possibleArguments.possibleArguments;
            }
        }
        await fs.writeFile(opts.discoveryOnly, JSON.stringify(initialCompilers));
        logger.info(`Discovered compilers saved to ${opts.discoveryOnly}`);
        process.exit(0);
    }

    const noscriptHandler = new NoScriptHandler(
        router,
        clientOptionsHandler,
        renderConfig,
        storageHandler,
        appArgs.wantedLanguages?.[0],
    );
    const routeApi = new RouteAPI(router, {
        compileHandler,
        clientOptionsHandler,
        storageHandler,
        compilationEnvironment,
        ceProps,
        defArgs: appArgs,
        renderConfig,
        renderGoldenLayout,
    });

    async function onCompilerChange(compilers: CompilerInfo[]) {
        if (JSON.stringify(prevCompilers) === JSON.stringify(compilers)) {
            return;
        }
        logger.info(`Compiler scan count: ${compilers.length}`);
        logger.debug('Compilers:', compilers);
        prevCompilers = compilers;
        await clientOptionsHandler.setCompilers(compilers);
        const apiHandler = unwrap(routeApi.apiHandler);
        apiHandler.setCompilers(compilers);
        apiHandler.setLanguages(languages);
        apiHandler.setOptions(clientOptionsHandler);
    }

    await onCompilerChange(initialCompilers);

    const rescanCompilerSecs = ceProps('rescanCompilerSecs', 0);
    if (rescanCompilerSecs && !opts.prediscovered) {
        logger.info(`Rescanning compilers every ${rescanCompilerSecs} secs`);
        setInterval(
            () => compilerFinder.find().then(result => onCompilerChange(result.compilers)),
            rescanCompilerSecs * 1000,
        );
    }

    const sentrySlowRequestMs = ceProps('sentrySlowRequestMs', 0);

    if (opts.metricsPort) {
        logger.info(`Running metrics server on port ${opts.metricsPort}`);
        setupMetricsServer(opts.metricsPort, appArgs.hostname);
    }

    webServer
        .set('trust proxy', true)
        .set('view engine', 'pug')
        .on('error', err => logger.error('Caught error in web handler; continuing:', err))
        // The healthcheck controller is hoisted to prevent it from being logged.
        // TODO: Migrate the logger to a shared middleware.
        .use(healthCheckController.createRouter())
        // eslint-disable-next-line no-unused-vars
        .use(
            responseTime((req, res, time) => {
                if (sentrySlowRequestMs > 0 && time >= sentrySlowRequestMs) {
                    Sentry.withScope((scope: Sentry.Scope) => {
                        scope.setExtra('duration_ms', time);
                        Sentry.captureMessage('SlowRequest', 'warning');
                    });
                }
            }),
        )
        .use(httpRoot, router)
        .use((req, res, next) => {
            next({status: 404, message: `page "${req.path}" could not be found`});
        });

    Sentry.setupExpressErrorHandler(webServer);

    // eslint-disable-next-line no-unused-vars
    webServer.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const status = err.status || err.statusCode || err.status_code || err.output?.statusCode || 500;
        const message = err.message || 'Internal Server Error';
        res.status(status);
        res.render('error', renderConfig({error: {code: status, message: message}}));
        if (status >= 500) {
            logger.error('Internal server error:', err);
        }
    });

    const sponsorConfig = loadSponsorsFromString(await fs.readFile(configDir + '/sponsors.yaml', 'utf8'));

    function renderConfig(extra: Record<string, any>, urlOptions?: Record<string, any>) {
        const urlOptionsAllowed = ['readOnly', 'hideEditorToolbars', 'language'];
        const filteredUrlOptions = _.mapObject(_.pick(urlOptions || {}, urlOptionsAllowed), val =>
            utils.toProperty(val),
        );
        const allExtraOptions = _.extend({}, filteredUrlOptions, extra);

        if (allExtraOptions.mobileViewer && allExtraOptions.config) {
            const clnormalizer = new normalizer.ClientStateNormalizer();
            clnormalizer.fromGoldenLayout(allExtraOptions.config);
            const clientstate = clnormalizer.normalized;

            const glnormalizer = new normalizer.ClientStateGoldenifier();
            allExtraOptions.slides = glnormalizer.generatePresentationModeMobileViewerSlides(clientstate);
        }

        const options = _.extend({}, allExtraOptions, clientOptionsHandler.get());
        options.optionsHash = clientOptionsHandler.getHash();
        options.compilerExplorerOptions = JSON.stringify(allExtraOptions);
        options.extraBodyClass = options.embedded ? 'embedded' : extraBodyClass;
        options.httpRoot = httpRoot;
        options.staticRoot = staticRoot;
        options.storageSolution = storageSolution;
        options.require = pugRequireHandler;
        options.sponsors = sponsorConfig;
        return options;
    }

    function isMobileViewer(req: express.Request) {
        return req.header('CloudFront-Is-Mobile-Viewer') === 'true';
    }

    function renderGoldenLayout(
        config: GoldenLayoutRootStruct,
        metadata: ShortLinkMetaData,
        req: express.Request,
        res: express.Response,
    ) {
        const embedded = req.query.embedded === 'true';

        res.render(
            embedded ? 'embed' : 'index',
            renderConfig(
                {
                    embedded: embedded,
                    mobileViewer: isMobileViewer(req),
                    config: config,
                    metadata: metadata,
                    storedStateId: req.params.id || false,
                },
                req.query,
            ),
        );
    }

    const embeddedHandler = (req: express.Request, res: express.Response) => {
        res.render(
            'embed',
            renderConfig(
                {
                    embedded: true,
                    mobileViewer: isMobileViewer(req),
                },
                req.query,
            ),
        );
    };

    await (isDevMode() ? setupWebPackDevMiddleware(router) : setupStaticMiddleware(router));

    morgan.token('gdpr_ip', (req: any) => (req.ip ? utils.anonymizeIp(req.ip) : ''));

    // Based on combined format, but: GDPR compliant IP, no timestamp & no unused fields for our usecase
    const morganFormat = isDevMode() ? 'dev' : ':gdpr_ip ":method :url" :status';

    router
        .use(
            morgan(morganFormat, {
                stream: makeLogStream('info'),
                // Skip for non errors (2xx, 3xx)
                skip: (req: express.Request, res: express.Response) => res.statusCode >= 400,
            }),
        )
        .use(
            morgan(morganFormat, {
                stream: makeLogStream('warn'),
                // Skip for non user errors (4xx)
                skip: (req: express.Request, res: express.Response) => res.statusCode < 400 || res.statusCode >= 500,
            }),
        )
        .use(
            morgan(morganFormat, {
                stream: makeLogStream('error'),
                // Skip for non server errors (5xx)
                skip: (req: express.Request, res: express.Response) => res.statusCode < 500,
            }),
        )
        .use(compression())
        .get('/', cached, csp, (req, res) => {
            res.render(
                'index',
                renderConfig(
                    {
                        embedded: false,
                        mobileViewer: isMobileViewer(req),
                    },
                    req.query,
                ),
            );
        })
        .get('/e', cached, csp, embeddedHandler)
        // legacy. not a 301 to prevent any redirect loops between old e links and embed.html
        .get('/embed.html', cached, csp, embeddedHandler)
        .get('/embed-ro', cached, csp, (req, res) => {
            res.render(
                'embed',
                renderConfig(
                    {
                        embedded: true,
                        readOnly: true,
                        mobileViewer: isMobileViewer(req),
                    },
                    req.query,
                ),
            );
        })
        .get('/robots.txt', cached, (req, res) => {
            res.end('User-agent: *\nSitemap: https://godbolt.org/sitemap.xml\nDisallow:');
        })
        .get('/sitemap.xml', cached, (req, res) => {
            res.set('Content-Type', 'application/xml');
            res.render('sitemap');
        })
        .use(sFavicon(utils.resolvePathFromAppRoot('static/favicons', getFaviconFilename())))
        .get('/client-options.js', cached, (req, res) => {
            res.set('Content-Type', 'application/javascript');
            res.end(`window.compilerExplorerOptions = ${clientOptionsHandler.getJSON()};`);
        })
        .use('/bits/:bits.html', cached, csp, (req, res) => {
            res.render(
                `bits/${sanitize(req.params.bits)}`,
                renderConfig(
                    {
                        embedded: false,
                        mobileViewer: isMobileViewer(req),
                    },
                    req.query,
                ),
            );
        })
        .use(express.json({limit: ceProps('bodyParserLimit', maxUploadSize)}))
        .use(siteTemplateController.createRouter())
        .use(sourceController.createRouter())
        .use(assemblyDocumentationController.createRouter())
        .use(formattingController.createRouter())
        .use(noScriptController.createRouter())
        .get('/g/:id', oldGoogleUrlHandler);

    noscriptHandler.initializeRoutes();
    routeApi.initializeRoutes();

    if (!appArgs.doCache) {
        logger.info('  with disabled caching');
    }
    setupEventLoopLagLogging();

    if (isExecutionWorker) {
        await initHostSpecialties();

        startExecutionWorkerThread(ceProps, awsProps, compilationEnvironment);
    }

    startListening(webServer);
}

if (opts.version) {
    logger.info('Compiler Explorer version info:');
    logger.info(`  git release ${gitReleaseName}`);
    logger.info(`  release build ${releaseBuildNumber}`);
    logger.info('Exiting');
    process.exit(0);
}

process.on('uncaughtException', uncaughtHandler);
process.on('SIGINT', signalHandler('SIGINT'));
process.on('SIGTERM', signalHandler('SIGTERM'));
process.on('SIGQUIT', signalHandler('SIGQUIT'));

function signalHandler(name: string) {
    return () => {
        logger.info(`stopping process: ${name}`);
        process.exit(0);
    };
}

function uncaughtHandler(err: Error, origin: NodeJS.UncaughtExceptionOrigin) {
    logger.info(`stopping process: Uncaught exception: ${err}\nException origin: ${origin}`);
    // The app will exit naturally from here, but if we call `process.exit()` we may lose log lines.
    // see https://github.com/winstonjs/winston/issues/1504#issuecomment-1033087411
    process.exitCode = 1;
}

// Once we move to modules, we can remove this and use a top level await.
// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch(err => {
    logger.error('Top-level error (shutting down):', err);
    // Shut down after a second to hopefully let logs flush.
    setTimeout(() => process.exit(1), 1000);
});
