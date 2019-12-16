import {
  join
} from 'path'

import os from 'os'
import fs from 'fs-extra'
import multiaddr from 'multiaddr'
import http from 'http'
import getPort from 'get-port'
import {
  shell
} from 'electron'
import i18n from 'i18next'
import {
  showDialog
} from '../dialogs'
import store from '../common/store'
import logger from '../common/logger'

export function configPath(ipfsd) {
  return join(ipfsd.repoPath, 'config')
}

function readConfigFile(ipfsd) {
  return fs.readJsonSync(configPath(ipfsd))
}

function writeConfigFile(ipfsd, config) {
  fs.writeJsonSync(configPath(ipfsd), config, {
    spaces: 2
  })
}

// Set default mininum and maximum of connections to mantain
// by default. This must only be called for repositories created
// by BCFS Desktop. Existing ones shall remain intact.
export function applyDefaults(ipfsd) {
  const config = readConfigFile(ipfsd)

  // Ensure strict CORS checking
  // See: https://github.com/ipfs/js-ipfsd-ctl/issues/333
  config.API = {
    HTTPHeaders: {
      "Access-Control-Allow-Methods": [
        "PUT",
        "GET",
        "POST"
      ],
      "Access-Control-Allow-Origin": [
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://video.slyzn.com",
      ]
    }
  }

  config.Swarm = config.Swarm || {}
  config.Swarm.DisableNatPortMap = false
  config.Swarm.ConnMgr = config.Swarm.ConnMgr || {}
  config.Swarm.ConnMgr.GracePeriod = '300s'
  config.Swarm.ConnMgr.LowWater = 50
  config.Swarm.ConnMgr.HighWater = 300

  config.Discovery = config.Discovery || {}
  config.Discovery.MDNS = config.Discovery.MDNS || {}
  config.Discovery.MDNS.enabled = true

  writeConfigFile(ipfsd, config)
}

export async function applyBcfsDefaults(ipfsd, inited = true) {
  logger.info("[bcfs-node] get start")
 
  let bcfsnodes = await getBcfsNodes()
  logger.info(`[bcfs-node] bcfs-node ${typeof(bcfsnodes)}`)
  logger.info(`[bcfs-node] start add node ${bcfsnodes}`)
  const config = readConfigFile(ipfsd)
  checkBcfsSwarmKey(ipfsd)
  try {
    let accessOrigin = config.API.HTTPHeaders["Access-Control-Allow-Origin"]
    logger.info(`[bcfs-node] add access origin ${accessOrigin}`)
    let slyznDomain = "http://video.slyzn.com"
    if (accessOrigin.indexOf(slyznDomain) < 0) {
      logger.info(`[bcfs-node] add access origin video.slyzn.com`)
      accessOrigin.push(slyznDomain)
    }
  } catch (error) {
      logger.error(`[bcfs-node] check access origin ${error}`)
  }

  if (bcfsnodes && bcfsnodes.length > 0) {
    // config.Bootstrap = []
    for (let n of bcfsnodes) {
      if (config.Bootstrap.indexOf(n.trim()) < 0) {
        config.Bootstrap.push(n)
        logger.info(`[bcfs-node] add node ${n} success`)
      }
    }
  }

  // add bcfs swarm.key

  // // Ensure strict CORS checking
  // // See: https://github.com/ipfs/js-ipfsd-ctl/issues/333
  // config.API = { HTTPHeaders: {} }
  writeConfigFile(ipfsd, config)
}

async function getBcfsNodes(){
   // request bcfs nodes
   const options = {
    method: 'GET',
    timeout: 3000,
    host: 'ipfsserver.slyzn.com',
    path: '/config/get/bcfs.node'
  }
  return new Promise(resolve => {
    let req = http.request(options, function (r) {
      logger.info(`[bcfs-node] http get status ${r.statusCode}`)
      r.on("data", function (data) {
        logger.info(`[bcfs-node] http get node ${data}`)
        resolve(JSON.parse(data))
      })
    })
    req.on("timeout", function (res) {
      resolve([])
      logger.info(`[bcfs-node] http get node timeout`)
    })
    req.on("error", function (e) {
      resolve([])
      logger.error(`[bcfs-node] http get node ${e}`);
    })
    req.end()
  })
}

 async function checkBcfsSwarmKey(ipfsd){
   // request bcfs nodes
   const options = {
    method: 'GET',
    timeout: 3000,
    host: 'ipfsserver.slyzn.com',
    path: '/config/get/swarm.key.line'
  }
  
  let repoPath = ipfsd.repoPath
  let swarmpath = join(repoPath ,'swarm.key')

  logger.info(`[bcfs-node] swarn key path ${swarmpath}`)
  let osname = os.type()
  logger.info(`os.name == ${os.type}`)
  const swarnExists = await fs.pathExists(swarmpath)
  logger.info(`[bcfs-node] swarn key exists ${swarnExists }`)
  if(!swarnExists){
    let swarmtxt = await new Promise(resolve => {
      let req = http.request(options, function (r) {
        logger.info(`[bcfs-node] http get swarm key ${r.statusCode}`)
        r.on("data", function (data) {
          logger.info(`[bcfs-node] http get swarmkey ${data}`)
          resolve(data)
        })
      })
      req.on("error", function (e) {
        resolve([])
        logger.error(`[bcfs-node] http get swarm key ${e}`);
      })
      req.end()
    })
    switch(osname){
      case 'Windows_NT':
        swarmtxt = swarmtxt.toString().replace("/\r","/\r/\n")
          break;
      case 'Darwin':
        //swarmtxt = swarmtxt.toString().replace("/\n","")
        break;
      default:
        break;
    }
    fs.writeFileSync(swarmpath,swarmtxt)
  }

}


// Check for * and webui://- in allowed origins on API headers.
// The wildcard was a ipfsd-ctl default, that we don't want, and
// webui://- was an earlier experiement that should be cleared out.
//
// We remove them the first time we find them. If we find it again on subsequent
// runs then we leave them in, under the assumption that you really want it.
// TODO: show warning in UI when wildcard is in the allowed origins.
export function checkCorsConfig(ipfsd) {
  if (store.get('checkedCorsConfig')) {
    // We've already checked so skip it.
    return
  }

  let config = null

  try {
    config = readConfigFile(ipfsd)
  } catch (err) {
    // This is a best effort check, dont blow up here, that should happen else where.
    // TODO: gracefully handle config errors elsewhere!
    logger.error(`[daemon] checkCorsConfig: error reading config file: ${err.message || err}`)
    return
  }

  if (config.API && config.API.HTTPHeaders && config.API.HTTPHeaders['Access-Control-Allow-Origin']) {
    const allowedOrigins = config.API.HTTPHeaders['Access-Control-Allow-Origin']
    const originsToRemove = ['*', 'webui://-']

    if (Array.isArray(allowedOrigins)) {
      const specificOrigins = allowedOrigins.filter(origin => !originsToRemove.includes(origin))

      if (specificOrigins.length !== allowedOrigins.length) {
        config.API.HTTPHeaders['Access-Control-Allow-Origin'] = specificOrigins

        try {
          writeConfigFile(ipfsd, config)
          store.set('updatedCorsConfig', Date.now())
        } catch (err) {
          logger.error(`[daemon] checkCorsConfig: error writing config file: ${err.message || err}`)
          // don't skip setting checkedCorsConfig so we try again next time time.
          return
        }
      }
    }
  }

  store.set('checkedCorsConfig', true)
}

const parseCfgMultiaddr = (addr) => (addr.includes('/http') ?
  multiaddr(addr) :
  multiaddr(addr).encapsulate('/http')
)

async function checkIfAddrIsDaemon(addr) {
  const options = {
    method: 'GET',
    host: addr.address,
    port: addr.port,
    path: '/api/v0/refs?arg=/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'
  }

  return new Promise(resolve => {
    var req = http.request(options, function (r) {
      resolve(r.statusCode === 200)
    })

    req.on('error', () => {
      resolve(false)
    })

    req.end()
  })
}

async function checkPortsArray(ipfsd, addrs) {
  addrs = addrs.filter(Boolean)

  for (const addr of addrs) {
    const ma = parseCfgMultiaddr(addr)
    const port = parseInt(ma.nodeAddress().port, 10)

    if (port === 0) {
      continue
    }

    const isDaemon = await checkIfAddrIsDaemon(ma.nodeAddress())

    if (isDaemon) {
      continue
    }

    const freePort = await getPort({
      port: getPort.makeRange(port, port + 100)
    })

    if (port !== freePort) {
      const opt = showDialog({
        title: i18n.t('multipleBusyPortsDialog.title'),
        message: i18n.t('multipleBusyPortsDialog.message'),
        type: 'error',
        buttons: [
          i18n.t('multipleBusyPortsDialog.action'),
          i18n.t('close')
        ]
      })

      if (opt === 0) {
        shell.openItem(join(ipfsd.repoPath, 'config'))
      }

      throw new Error('ports already being used')
    }
  }
}

export async function checkPorts(ipfsd) {
  const config = readConfigFile(ipfsd)

  const apiIsArr = Array.isArray(config.Addresses.API)
  const gatewayIsArr = Array.isArray(config.Addresses.Gateway)

  if (apiIsArr || gatewayIsArr) {
    logger.info('[daemon] custom configuration with array of API or Gateway addrs')
    return checkPortsArray(ipfsd, [].concat(config.Addresses.API, config.Addresses.Gateway))
  }

  const configApiMa = parseCfgMultiaddr(config.Addresses.API)
  const configGatewayMa = parseCfgMultiaddr(config.Addresses.Gateway)

  const isApiMaDaemon = await checkIfAddrIsDaemon(configApiMa.nodeAddress())
  const isGatewayMaDaemon = await checkIfAddrIsDaemon(configGatewayMa.nodeAddress())

  if (isApiMaDaemon && isGatewayMaDaemon) {
    logger.info('[daemon] ports busy by a daemon')
    return
  }

  const apiPort = parseInt(configApiMa.nodeAddress().port, 10)
  const gatewayPort = parseInt(configGatewayMa.nodeAddress().port, 10)

  const freeGatewayPort = await getPort({
    port: getPort.makeRange(gatewayPort, gatewayPort + 100)
  })
  const freeApiPort = await getPort({
    port: getPort.makeRange(apiPort, apiPort + 100)
  })

  const busyApiPort = apiPort !== freeApiPort
  const busyGatewayPort = gatewayPort !== freeGatewayPort

  if (!busyApiPort && !busyGatewayPort) {
    return
  }

  let message = null
  let options = null

  if (busyApiPort && busyGatewayPort) {
    logger.info('[daemon] api and gateway ports busy')
    message = 'busyPortsDialog'
    options = {
      port1: apiPort,
      alt1: freeApiPort,
      port2: gatewayPort,
      alt2: freeGatewayPort
    }
  } else if (busyApiPort) {
    logger.info('[daemon] api port busy')
    message = 'busyPortDialog'
    options = {
      port: apiPort,
      alt: freeApiPort
    }
  } else {
    logger.info('[daemon] gateway port busy')
    message = 'busyPortDialog'
    options = {
      port: gatewayPort,
      alt: freeGatewayPort
    }
  }

  const opt = showDialog({
    title: i18n.t(`${message}.title`),
    message: i18n.t(`${message}.message`, options),
    type: 'error',
    buttons: [
      i18n.t(`${message}.action`, options),
      i18n.t('close')
    ]
  })

  if (opt !== 0) {
    throw new Error('ports already being used')
  }

  if (busyApiPort) {
    config.Addresses.API = config.Addresses.API.replace(apiPort.toString(), freeApiPort.toString())
  }

  if (busyGatewayPort) {
    config.Addresses.Gateway = config.Addresses.Gateway.replace(gatewayPort.toString(), freeGatewayPort.toString())
  }

  writeConfigFile(ipfsd, config)
  logger.info('[daemon] ports updated')
}