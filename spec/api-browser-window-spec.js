'use strict'

const chai = require('chai')
const dirtyChai = require('dirty-chai')
const fs = require('fs')
const path = require('path')
const os = require('os')
const qs = require('querystring')
const http = require('http')
const { closeWindow } = require('./window-helpers')
const { emittedOnce } = require('./events-helpers')
const { ipcRenderer, remote } = require('electron')
const { app, ipcMain, BrowserWindow, BrowserView, protocol, session, screen, webContents } = remote

const features = process.electronBinding('features')
const { expect } = chai
const isCI = remote.getGlobal('isCi')
const nativeModulesEnabled = remote.getGlobal('nativeModulesEnabled')

chai.use(dirtyChai)

describe('BrowserWindow module', () => {
  const fixtures = path.resolve(__dirname, 'fixtures')
  let w = null
  let iw = null
  let ws = null
  let server
  let postData

  const defaultOptions = {
    show: false,
    width: 400,
    height: 400,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: true
    }
  }

  const openTheWindow = async (options = defaultOptions) => {
    // The `afterEach` hook isn't called if a test fails,
    // we should make sure that the window is closed ourselves.
    await closeTheWindow()

    w = new BrowserWindow(options)
    return w
  }

  const closeTheWindow = function () {
    return closeWindow(w).then(() => { w = null })
  }

  before((done) => {
    const filePath = path.join(fixtures, 'pages', 'a.html')
    const fileStats = fs.statSync(filePath)
    postData = [
      {
        type: 'rawData',
        bytes: Buffer.from('username=test&file=')
      },
      {
        type: 'file',
        filePath: filePath,
        offset: 0,
        length: fileStats.size,
        modificationTime: fileStats.mtime.getTime() / 1000
      }
    ]
    server = http.createServer((req, res) => {
      function respond () {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (data) => {
            if (data) body += data
          })
          req.on('end', () => {
            const parsedData = qs.parse(body)
            fs.readFile(filePath, (err, data) => {
              if (err) return
              if (parsedData.username === 'test' &&
                  parsedData.file === data.toString()) {
                res.end()
              }
            })
          })
        } else if (req.url === '/302') {
          res.setHeader('Location', '/200')
          res.statusCode = 302
          res.end()
        } else if (req.url === '/navigate-302') {
          res.end(`<html><body><script>window.location='${server.url}/302'</script></body></html>`)
        } else if (req.url === '/cross-site') {
          res.end(`<html><body><h1>${req.url}</h1></body></html>`)
        } else {
          res.end()
        }
      }
      setTimeout(respond, req.url.includes('slow') ? 200 : 0)
    })
    server.listen(0, '127.0.0.1', () => {
      server.url = `http://127.0.0.1:${server.address().port}`
      done()
    })
  })

  after(() => {
    server.close()
    server = null
  })

  beforeEach(openTheWindow)

  afterEach(closeTheWindow)

  describe('window states', () => {
    it('does not resize frameless windows when states change', () => {
      w.destroy()
      w = new BrowserWindow({
        frame: false,
        width: 300,
        height: 200,
        show: false
      })

      w.minimizable = false
      w.minimizable = true
      expect(w.getSize()).to.deep.equal([300, 200])

      w.resizable = false
      w.resizable = true
      expect(w.getSize()).to.deep.equal([300, 200])

      w.maximizable = false
      w.maximizable = true
      expect(w.getSize()).to.deep.equal([300, 200])

      w.fullScreenable = false
      w.fullScreenable = true
      expect(w.getSize()).to.deep.equal([300, 200])

      w.closable = false
      w.closable = true
      expect(w.getSize()).to.deep.equal([300, 200])
    })

    describe('resizable state', () => {
      it('can be changed with resizable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, resizable: false })
        expect(w.resizable).to.be.false()

        if (process.platform === 'darwin') {
          expect(w.maximizable).to.to.true()
        }
      })

      // TODO(codebytere): remove when propertyification is complete
      it('can be changed with setResizable method', () => {
        expect(w.isResizable()).to.be.true()
        w.setResizable(false)
        expect(w.isResizable()).to.be.false()
        w.setResizable(true)
        expect(w.isResizable()).to.be.true()
      })

      it('can be changed with resizable property', () => {
        expect(w.resizable).to.be.true()
        w.resizable = false
        expect(w.resizable).to.be.false()
        w.resizable = true
        expect(w.resizable).to.be.true()
      })

      it('works for a frameless window', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, frame: false })
        expect(w.resizable).to.be.true()

        if (process.platform === 'win32') {
          w.destroy()
          w = new BrowserWindow({ show: false, thickFrame: false })
          expect(w.resizable).to.be.false()
        }
      })

      if (process.platform === 'win32') {
        it('works for a window smaller than 64x64', () => {
          w.destroy()
          w = new BrowserWindow({
            show: false,
            frame: false,
            resizable: false,
            transparent: true
          })
          w.setContentSize(60, 60)
          expectBoundsEqual(w.getContentSize(), [60, 60])
          w.setContentSize(30, 30)
          expectBoundsEqual(w.getContentSize(), [30, 30])
          w.setContentSize(10, 10)
          expectBoundsEqual(w.getContentSize(), [10, 10])
        })
      }
    })

    describe('loading main frame state', () => {
      it('is true when the main frame is loading', (done) => {
        w.webContents.on('did-start-loading', () => {
          expect(w.webContents.isLoadingMainFrame()).to.be.true()
          done()
        })
        w.webContents.loadURL(server.url)
      })
      it('is false when only a subframe is loading', (done) => {
        w.webContents.once('did-finish-load', () => {
          expect(w.webContents.isLoadingMainFrame()).to.be.false()
          w.webContents.on('did-start-loading', () => {
            expect(w.webContents.isLoadingMainFrame()).to.be.false()
            done()
          })
          w.webContents.executeJavaScript(`
            var iframe = document.createElement('iframe')
            iframe.src = '${server.url}/page2'
            document.body.appendChild(iframe)
          `)
        })
        w.webContents.loadURL(server.url)
      })
      it('is true when navigating to pages from the same origin', (done) => {
        w.webContents.once('did-finish-load', () => {
          expect(w.webContents.isLoadingMainFrame()).to.be.false()
          w.webContents.on('did-start-loading', () => {
            expect(w.webContents.isLoadingMainFrame()).to.be.true()
            done()
          })
          w.webContents.loadURL(`${server.url}/page2`)
        })
        w.webContents.loadURL(server.url)
      })
    })
  })

  describe('window states (excluding Linux)', () => {
    // FIXME(alexeykuzmin): Skip the tests instead of using the `return` here.
    // Why it cannot be done now:
    // - `.skip()` called in the 'before' hook doesn't affect
    //     nested `describe`s.
    // - `.skip()` called in the 'beforeEach' hook prevents 'afterEach'
    //     hook from being called.
    // Not implemented on Linux.
    if (process.platform === 'linux') {
      return
    }

    describe('movable state (property)', () => {
      it('can be changed with movable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, movable: false })
        expect(w.movable).to.be.false()
      })
      it('can be changed with movable property', () => {
        expect(w.movable).to.be.true()
        w.movable = false
        expect(w.movable).to.be.false()
        w.movable = true
        expect(w.movable).to.be.true()
      })
    })

    // TODO(codebytere): remove when propertyification is complete
    describe('movable state (methods)', () => {
      it('can be changed with movable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, movable: false })
        expect(w.isMovable()).to.be.false()
      })
      it('can be changed with setMovable method', () => {
        expect(w.isMovable()).to.be.true()
        w.setMovable(false)
        expect(w.isMovable()).to.be.false()
        w.setMovable(true)
        expect(w.isMovable()).to.be.true()
      })
    })

    describe('minimizable state (property)', () => {
      it('can be changed with minimizable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, minimizable: false })
        expect(w.minimizable).to.be.false()
      })

      it('can be changed with minimizable property', () => {
        expect(w.minimizable).to.be.true()
        w.minimizable = false
        expect(w.minimizable).to.be.false()
        w.minimizable = true
        expect(w.minimizable).to.be.true()
      })
    })

    // TODO(codebytere): remove when propertyification is complete
    describe('minimizable state (methods)', () => {
      it('can be changed with minimizable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, minimizable: false })
        expect(w.isMinimizable()).to.be.false()
      })

      it('can be changed with setMinimizable method', () => {
        expect(w.isMinimizable()).to.be.true()
        w.setMinimizable(false)
        expect(w.isMinimizable()).to.be.false()
        w.setMinimizable(true)
        expect(w.isMinimizable()).to.be.true()
      })
    })

    describe('maximizable state (property)', () => {
      it('can be changed with maximizable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, maximizable: false })
        expect(w.maximizable).to.be.false()
      })

      it('can be changed with maximizable property', () => {
        expect(w.maximizable).to.be.true()
        w.maximizable = false
        expect(w.maximizable).to.be.false()
        w.maximizable = true
        expect(w.maximizable).to.be.true()
      })

      it('is not affected when changing other states', () => {
        w.maximizable = false
        expect(w.maximizable).to.be.false()
        w.minimizable = false
        expect(w.maximizable).to.be.false()
        w.closable = false
        expect(w.maximizable).to.be.false()

        w.maximizable = true
        expect(w.maximizable).to.be.true()
        w.closable = true
        expect(w.maximizable).to.be.true()
        w.fullScreenable = false
        expect(w.maximizable).to.be.true()
      })
    })

    // TODO(codebytere): remove when propertyification is complete
    describe('maximizable state (methods)', () => {
      it('can be changed with maximizable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, maximizable: false })
        expect(w.isMaximizable()).to.be.false()
      })

      it('can be changed with setMaximizable method', () => {
        expect(w.isMaximizable()).to.be.true()
        w.setMaximizable(false)
        expect(w.isMaximizable()).to.be.false()
        w.setMaximizable(true)
        expect(w.isMaximizable()).to.be.true()
      })

      it('is not affected when changing other states', () => {
        w.setMaximizable(false)
        expect(w.isMaximizable()).to.be.false()
        w.setMinimizable(false)
        expect(w.isMaximizable()).to.be.false()
        w.setClosable(false)
        expect(w.isMaximizable()).to.be.false()

        w.setMaximizable(true)
        expect(w.isMaximizable()).to.be.true()
        w.setClosable(true)
        expect(w.isMaximizable()).to.be.true()
        w.setFullScreenable(false)
        expect(w.isMaximizable()).to.be.true()
      })
    })

    describe('maximizable state (Windows only)', () => {
      // Only implemented on windows.
      if (process.platform !== 'win32') return

      it('is reset to its former state', () => {
        w.maximizable = false
        w.resizable = false
        w.resizable = true
        expect(w.maximizable).to.be.false()
        w.maximizable = true
        w.resizable = false
        w.resizable = true
        expect(w.maximizable).to.be.true()
      })
    })

    // TODO(codebytere): remove when propertyification is complete
    describe('maximizable state (Windows only) (methods)', () => {
      // Only implemented on windows.
      if (process.platform !== 'win32') return

      it('is reset to its former state', () => {
        w.setMaximizable(false)
        w.setResizable(false)
        w.setResizable(true)
        expect(w.isMaximizable()).to.be.false()
        w.setMaximizable(true)
        w.setResizable(false)
        w.setResizable(true)
        expect(w.isMaximizable()).to.be.true()
      })
    })

    describe('fullscreenable state (property)', () => {
      before(function () {
        if (process.platform !== 'darwin') this.skip()
      })

      it('can be changed with fullscreenable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, fullscreenable: false })
        expect(w.fullScreenable).to.be.false()
      })

      it('can be changed with fullScreenable property', () => {
        expect(w.fullScreenable).to.be.true()
        w.fullScreenable = false
        expect(w.fullScreenable).to.be.false()
        w.fullScreenable = true
        expect(w.fullScreenable).to.be.true()
      })
    })

    // TODO(codebytere): remove when propertyification is complete
    describe('fullscreenable state (methods)', () => {
      before(function () {
        if (process.platform !== 'darwin') this.skip()
      })

      it('can be changed with fullscreenable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, fullscreenable: false })
        expect(w.isFullScreenable()).to.be.false()
      })

      it('can be changed with setFullScreenable method', () => {
        expect(w.isFullScreenable()).to.be.true()
        w.setFullScreenable(false)
        expect(w.isFullScreenable()).to.be.false()
        w.setFullScreenable(true)
        expect(w.isFullScreenable()).to.be.true()
      })
    })

    describe('kiosk state', () => {
      before(function () {
        // Only implemented on macOS.
        if (process.platform !== 'darwin') {
          this.skip()
        }
      })

      it('can be changed with setKiosk method', (done) => {
        w.destroy()
        w = new BrowserWindow()
        w.setKiosk(true)
        expect(w.isKiosk()).to.be.true()

        w.once('enter-full-screen', () => {
          w.setKiosk(false)
          expect(w.isKiosk()).to.be.false()
        })
        w.once('leave-full-screen', () => {
          done()
        })
      })
    })

    describe('fullscreen state with resizable set', () => {
      before(function () {
        if (process.platform !== 'darwin') this.skip()
      })

      it('resizable flag should be set to true and restored', (done) => {
        w.destroy()
        w = new BrowserWindow({ resizable: false })
        w.once('enter-full-screen', () => {
          expect(w.resizable).to.be.true()
          w.setFullScreen(false)
        })
        w.once('leave-full-screen', () => {
          expect(w.resizable).to.be.false()
          done()
        })
        w.setFullScreen(true)
      })
    })

    describe('fullscreen state', () => {
      before(function () {
        // Only implemented on macOS.
        if (process.platform !== 'darwin') {
          this.skip()
        }
      })

      it('can be changed with setFullScreen method', (done) => {
        w.destroy()
        w = new BrowserWindow()
        w.once('enter-full-screen', () => {
          expect(w.isFullScreen()).to.be.true()
          w.setFullScreen(false)
        })
        w.once('leave-full-screen', () => {
          expect(w.isFullScreen()).to.be.false()
          done()
        })
        w.setFullScreen(true)
      })

      it('should not be changed by setKiosk method', (done) => {
        w.destroy()
        w = new BrowserWindow()
        w.once('enter-full-screen', () => {
          expect(w.isFullScreen()).to.be.true()
          w.setKiosk(true)
          w.setKiosk(false)
          expect(w.isFullScreen()).to.be.true()
          w.setFullScreen(false)
        })
        w.once('leave-full-screen', () => {
          expect(w.isFullScreen()).to.be.false()
          done()
        })
        w.setFullScreen(true)
      })
    })

    describe('closable state (property)', () => {
      it('can be changed with closable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, closable: false })
        expect(w.closable).to.be.false()
      })

      it('can be changed with setClosable method', () => {
        expect(w.closable).to.be.true()
        w.closable = false
        expect(w.closable).to.be.false()
        w.closable = true
        expect(w.closable).to.be.true()
      })
    })

    // TODO(codebytere): remove when propertyification is complete
    describe('closable state (methods)', () => {
      it('can be changed with closable option', () => {
        w.destroy()
        w = new BrowserWindow({ show: false, closable: false })
        expect(w.isClosable()).to.be.false()
      })

      it('can be changed with setClosable method', () => {
        expect(w.isClosable()).to.be.true()
        w.setClosable(false)
        expect(w.isClosable()).to.be.false()
        w.setClosable(true)
        expect(w.isClosable()).to.be.true()
      })
    })

    describe('hasShadow state', () => {
      // On Window there is no shadow by default and it can not be changed
      // dynamically.
      it('can be changed with hasShadow option', () => {
        w.destroy()
        const hasShadow = process.platform !== 'darwin'
        w = new BrowserWindow({ show: false, hasShadow: hasShadow })
        expect(w.hasShadow()).to.equal(hasShadow)
      })

      it('can be changed with setHasShadow method', () => {
        if (process.platform !== 'darwin') return

        expect(w.hasShadow()).to.be.true()
        w.setHasShadow(false)
        expect(w.hasShadow()).to.be.false()
        w.setHasShadow(true)
        expect(w.hasShadow()).to.be.true()
      })
    })
  })

  describe('window.webContents.send(channel, args...)', () => {
    it('throws an error when the channel is missing', () => {
      expect(() => {
        w.webContents.send()
      }).to.throw('Missing required channel argument')

      expect(() => {
        w.webContents.send(null)
      }).to.throw('Missing required channel argument')
    })
  })

  describe('window.getNativeWindowHandle()', () => {
    before(function () {
      if (!nativeModulesEnabled) {
        this.skip()
      }
    })

    it('returns valid handle', () => {
      // The module's source code is hosted at
      // https://github.com/electron/node-is-valid-window
      const isValidWindow = remote.require('is-valid-window')
      expect(isValidWindow(w.getNativeWindowHandle())).to.be.true()
    })
  })

  describe('extensions and dev tools extensions', () => {
    let showPanelTimeoutId

    const showLastDevToolsPanel = () => {
      w.webContents.once('devtools-opened', () => {
        const show = () => {
          if (w == null || w.isDestroyed()) return
          const { devToolsWebContents } = w
          if (devToolsWebContents == null || devToolsWebContents.isDestroyed()) {
            return
          }

          const showLastPanel = () => {
            const lastPanelId = UI.inspectorView._tabbedPane._tabs.peekLast().id
            UI.inspectorView.showPanel(lastPanelId)
          }
          devToolsWebContents.executeJavaScript(`(${showLastPanel})()`, false).then(() => {
            showPanelTimeoutId = setTimeout(show, 100)
          })
        }
        showPanelTimeoutId = setTimeout(show, 100)
      })
    }

    afterEach(() => {
      clearTimeout(showPanelTimeoutId)
    })

    describe('BrowserWindow.addDevToolsExtension', () => {
      describe('for invalid extensions', () => {
        it('throws errors for missing manifest.json files', () => {
          const nonexistentExtensionPath = path.join(__dirname, 'does-not-exist')
          expect(() => {
            BrowserWindow.addDevToolsExtension(nonexistentExtensionPath)
          }).to.throw(/ENOENT: no such file or directory/)
        })

        it('throws errors for invalid manifest.json files', () => {
          const badManifestExtensionPath = path.join(__dirname, 'fixtures', 'devtools-extensions', 'bad-manifest')
          expect(() => {
            BrowserWindow.addDevToolsExtension(badManifestExtensionPath)
          }).to.throw(/Unexpected token }/)
        })
      })

      describe('for a valid extension', () => {
        const extensionName = 'foo'

        const removeExtension = () => {
          BrowserWindow.removeDevToolsExtension('foo')
          expect(BrowserWindow.getDevToolsExtensions()).to.not.have.a.property(extensionName)
        }

        const addExtension = () => {
          const extensionPath = path.join(__dirname, 'fixtures', 'devtools-extensions', 'foo')
          BrowserWindow.addDevToolsExtension(extensionPath)
          expect(BrowserWindow.getDevToolsExtensions()).to.have.a.property(extensionName)

          showLastDevToolsPanel()

          w.loadURL('about:blank')
        }

        // After* hooks won't be called if a test fail.
        // So let's make a clean-up in the before hook.
        beforeEach(removeExtension)

        describe('when the devtools is docked', () => {
          beforeEach(function (done) {
            addExtension()
            w.webContents.openDevTools({ mode: 'bottom' })
            ipcMain.once('answer', (event, message) => {
              this.message = message
              done()
            })
          })

          describe('created extension info', function () {
            it('has proper "runtimeId"', function () {
              expect(this.message).to.have.own.property('runtimeId')
              expect(this.message.runtimeId).to.equal(extensionName)
            })
            it('has "tabId" matching webContents id', function () {
              expect(this.message).to.have.own.property('tabId')
              expect(this.message.tabId).to.equal(w.webContents.id)
            })
            it('has "i18nString" with proper contents', function () {
              expect(this.message).to.have.own.property('i18nString')
              expect(this.message.i18nString).to.equal('foo - bar (baz)')
            })
            it('has "storageItems" with proper contents', function () {
              expect(this.message).to.have.own.property('storageItems')
              expect(this.message.storageItems).to.deep.equal({
                local: {
                  set: { hello: 'world', world: 'hello' },
                  remove: { world: 'hello' },
                  clear: {}
                },
                sync: {
                  set: { foo: 'bar', bar: 'foo' },
                  remove: { foo: 'bar' },
                  clear: {}
                }
              })
            })
          })
        })

        describe('when the devtools is undocked', () => {
          beforeEach(function (done) {
            addExtension()
            w.webContents.openDevTools({ mode: 'undocked' })
            ipcMain.once('answer', (event, message, extensionId) => {
              this.message = message
              done()
            })
          })

          describe('created extension info', function () {
            it('has proper "runtimeId"', function () {
              expect(this.message).to.have.own.property('runtimeId')
              expect(this.message.runtimeId).to.equal(extensionName)
            })
            it('has "tabId" matching webContents id', function () {
              expect(this.message).to.have.own.property('tabId')
              expect(this.message.tabId).to.equal(w.webContents.id)
            })
          })
        })
      })
    })

    it('works when used with partitions', (done) => {
      if (w != null) {
        w.destroy()
      }
      w = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: true,
          partition: 'temp'
        }
      })

      const extensionPath = path.join(__dirname, 'fixtures', 'devtools-extensions', 'foo')
      BrowserWindow.removeDevToolsExtension('foo')
      BrowserWindow.addDevToolsExtension(extensionPath)

      showLastDevToolsPanel()

      ipcMain.once('answer', function (event, message) {
        expect(message.runtimeId).to.equal('foo')
        done()
      })

      w.loadURL('about:blank')
      w.webContents.openDevTools({ mode: 'bottom' })
    })

    it('serializes the registered extensions on quit', () => {
      const extensionName = 'foo'
      const extensionPath = path.join(__dirname, 'fixtures', 'devtools-extensions', extensionName)
      const serializedPath = path.join(app.getPath('userData'), 'DevTools Extensions')

      BrowserWindow.addDevToolsExtension(extensionPath)
      app.emit('will-quit')
      expect(JSON.parse(fs.readFileSync(serializedPath))).to.deep.equal([extensionPath])

      BrowserWindow.removeDevToolsExtension(extensionName)
      app.emit('will-quit')
      expect(fs.existsSync(serializedPath)).to.be.false()
    })

    describe('BrowserWindow.addExtension', () => {
      beforeEach(() => {
        BrowserWindow.removeExtension('foo')
        expect(BrowserWindow.getExtensions()).to.not.have.property('foo')

        const extensionPath = path.join(__dirname, 'fixtures', 'devtools-extensions', 'foo')
        BrowserWindow.addExtension(extensionPath)
        expect(BrowserWindow.getExtensions()).to.have.property('foo')

        showLastDevToolsPanel()

        w.loadURL('about:blank')
      })

      it('throws errors for missing manifest.json files', () => {
        expect(() => {
          BrowserWindow.addExtension(path.join(__dirname, 'does-not-exist'))
        }).to.throw('ENOENT: no such file or directory')
      })

      it('throws errors for invalid manifest.json files', () => {
        expect(() => {
          BrowserWindow.addExtension(path.join(__dirname, 'fixtures', 'devtools-extensions', 'bad-manifest'))
        }).to.throw('Unexpected token }')
      })
    })
  })

  describe('window.webContents.executeJavaScript', () => {
    const expected = 'hello, world!'
    const expectedErrorMsg = 'woops!'
    const code = `(() => "${expected}")()`
    const asyncCode = `(() => new Promise(r => setTimeout(() => r("${expected}"), 500)))()`
    const badAsyncCode = `(() => new Promise((r, e) => setTimeout(() => e("${expectedErrorMsg}"), 500)))()`
    const errorTypes = new Set([
      Error,
      ReferenceError,
      EvalError,
      RangeError,
      SyntaxError,
      TypeError,
      URIError
    ])

    it('resolves the returned promise with the result', (done) => {
      ipcRenderer.send('executeJavaScript', code)
      ipcRenderer.once('executeJavaScript-promise-response', (event, result) => {
        expect(result).to.equal(expected)
        done()
      })
    })
    it('resolves the returned promise with the result if the code returns an asyncronous promise', (done) => {
      ipcRenderer.send('executeJavaScript', asyncCode)
      ipcRenderer.once('executeJavaScript-promise-response', (event, result) => {
        expect(result).to.equal(expected)
        done()
      })
    })
    it('rejects the returned promise if an async error is thrown', (done) => {
      ipcRenderer.send('executeJavaScript', badAsyncCode)
      ipcRenderer.once('executeJavaScript-promise-error', (event, error) => {
        expect(error).to.equal(expectedErrorMsg)
        done()
      })
    })
    it('rejects the returned promise with an error if an Error.prototype is thrown', async () => {
      for (const error in errorTypes) {
        await new Promise((resolve) => {
          ipcRenderer.send('executeJavaScript', `Promise.reject(new ${error.name}("Wamp-wamp")`)
          ipcRenderer.once('executeJavaScript-promise-error-name', (event, name) => {
            expect(name).to.equal(error.name)
            resolve()
          })
        })
      }
    })

    it('works after page load and during subframe load', (done) => {
      w.webContents.once('did-finish-load', () => {
        // initiate a sub-frame load, then try and execute script during it
        w.webContents.executeJavaScript(`
          var iframe = document.createElement('iframe')
          iframe.src = '${server.url}/slow'
          document.body.appendChild(iframe)
        `).then(() => {
          w.webContents.executeJavaScript('console.log(\'hello\')').then(() => {
            done()
          })
        })
      })
      w.loadURL(server.url)
    })

    it('executes after page load', (done) => {
      w.webContents.executeJavaScript(code).then(result => {
        expect(result).to.equal(expected)
        done()
      })
      w.loadURL(server.url)
    })

    it('works with result objects that have DOM class prototypes', (done) => {
      w.webContents.executeJavaScript('document.location').then(result => {
        expect(result.origin).to.equal(server.url)
        expect(result.protocol).to.equal('http:')
        done()
      })
      w.loadURL(server.url)
    })
  })

  describe('previewFile', () => {
    before(function () {
      if (process.platform !== 'darwin') {
        this.skip()
      }
    })

    it('opens the path in Quick Look on macOS', () => {
      expect(() => {
        w.previewFile(__filename)
        w.closeFilePreview()
      }).to.not.throw()
    })
  })

  describe('contextIsolation option with and without sandbox option', () => {
    const expectedContextData = {
      preloadContext: {
        preloadProperty: 'number',
        pageProperty: 'undefined',
        typeofRequire: 'function',
        typeofProcess: 'object',
        typeofArrayPush: 'function',
        typeofFunctionApply: 'function',
        typeofPreloadExecuteJavaScriptProperty: 'undefined'
      },
      pageContext: {
        preloadProperty: 'undefined',
        pageProperty: 'string',
        typeofRequire: 'undefined',
        typeofProcess: 'undefined',
        typeofArrayPush: 'number',
        typeofFunctionApply: 'boolean',
        typeofPreloadExecuteJavaScriptProperty: 'number',
        typeofOpenedWindow: 'object'
      }
    }

    beforeEach(() => {
      if (iw != null) iw.destroy()
      iw = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          preload: path.join(fixtures, 'api', 'isolated-preload.js')
        }
      })
      if (ws != null) ws.destroy()
      ws = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          preload: path.join(fixtures, 'api', 'isolated-preload.js')
        }
      })
    })

    afterEach(() => {
      if (iw != null) iw.destroy()
      if (ws != null) ws.destroy()
    })

    it('separates the page context from the Electron/preload context', async () => {
      const p = emittedOnce(ipcMain, 'isolated-world')
      iw.loadFile(path.join(fixtures, 'api', 'isolated.html'))
      const [, data] = await p
      expect(data).to.deep.equal(expectedContextData)
    })
    it('recreates the contexts on reload', async () => {
      await iw.loadFile(path.join(fixtures, 'api', 'isolated.html'))
      const isolatedWorld = emittedOnce(ipcMain, 'isolated-world')
      iw.webContents.reload()
      const [, data] = await isolatedWorld
      expect(data).to.deep.equal(expectedContextData)
    })
    it('enables context isolation on child windows', async () => {
      const browserWindowCreated = emittedOnce(app, 'browser-window-created')
      iw.loadFile(path.join(fixtures, 'pages', 'window-open.html'))
      const [, window] = await browserWindowCreated
      expect(window.webContents.getLastWebPreferences().contextIsolation).to.be.true()
    })
    it('separates the page context from the Electron/preload context with sandbox on', async () => {
      const p = emittedOnce(ipcMain, 'isolated-world')
      ws.loadFile(path.join(fixtures, 'api', 'isolated.html'))
      const [, data] = await p
      expect(data).to.deep.equal(expectedContextData)
    })
    it('recreates the contexts on reload with sandbox on', async () => {
      await ws.loadFile(path.join(fixtures, 'api', 'isolated.html'))
      const isolatedWorld = emittedOnce(ipcMain, 'isolated-world')
      ws.webContents.reload()
      const [, data] = await isolatedWorld
      expect(data).to.deep.equal(expectedContextData)
    })
    it('supports fetch api', async () => {
      const fetchWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          preload: path.join(fixtures, 'api', 'isolated-fetch-preload.js')
        }
      })
      const p = emittedOnce(ipcMain, 'isolated-fetch-error')
      fetchWindow.loadURL('about:blank')
      const [, error] = await p
      fetchWindow.destroy()
      expect(error).to.equal('Failed to fetch')
    })
    it('doesn\'t break ipc serialization', async () => {
      const p = emittedOnce(ipcMain, 'isolated-world')
      iw.loadURL('about:blank')
      iw.webContents.executeJavaScript(`
        const opened = window.open()
        openedLocation = opened.location.href
        opened.close()
        window.postMessage({openedLocation}, '*')
      `)
      const [, data] = await p
      expect(data.pageContext.openedLocation).to.equal('')
    })
  })

  describe('offscreen rendering', () => {
    beforeEach(function () {
      if (!features.isOffscreenRenderingEnabled()) {
        // XXX(alexeykuzmin): "afterEach" hook is not called
        // for skipped tests, we have to close the window manually.
        return closeTheWindow().then(() => { this.skip() })
      }

      if (w != null) w.destroy()
      w = new BrowserWindow({
        width: 100,
        height: 100,
        show: false,
        webPreferences: {
          backgroundThrottling: false,
          offscreen: true
        }
      })
    })

    it('creates offscreen window with correct size', (done) => {
      w.webContents.once('paint', function (event, rect, data) {
        expect(data.constructor.name).to.equal('NativeImage')
        expect(data.isEmpty()).to.be.false()
        const size = data.getSize()
        expect(size.width).to.be.closeTo(100 * devicePixelRatio, 2)
        expect(size.height).to.be.closeTo(100 * devicePixelRatio, 2)
        done()
      })
      w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
    })

    it('does not crash after navigation', () => {
      w.webContents.loadURL('about:blank')
      w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
    })

    describe('window.webContents.isOffscreen()', () => {
      it('is true for offscreen type', () => {
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
        expect(w.webContents.isOffscreen()).to.be.true()
      })

      it('is false for regular window', () => {
        const c = new BrowserWindow({ show: false })
        expect(c.webContents.isOffscreen()).to.be.false()
        c.destroy()
      })
    })

    describe('window.webContents.isPainting()', () => {
      it('returns whether is currently painting', (done) => {
        w.webContents.once('paint', function (event, rect, data) {
          expect(w.webContents.isPainting()).to.be.true()
          done()
        })
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
      })
    })

    describe('window.webContents.stopPainting()', () => {
      it('stops painting', (done) => {
        w.webContents.on('dom-ready', () => {
          w.webContents.stopPainting()
          expect(w.webContents.isPainting()).to.be.false()
          done()
        })
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
      })
    })

    describe('window.webContents.startPainting()', () => {
      it('starts painting', (done) => {
        w.webContents.on('dom-ready', () => {
          w.webContents.stopPainting()
          w.webContents.startPainting()
          w.webContents.once('paint', function (event, rect, data) {
            expect(w.webContents.isPainting()).to.be.true()
            done()
          })
        })
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
      })
    })

    // TODO(codebytere): remove in Electron v8.0.0
    describe('window.webContents.getFrameRate()', () => {
      it('has default frame rate', (done) => {
        w.webContents.once('paint', function (event, rect, data) {
          expect(w.webContents.getFrameRate()).to.equal(60)
          done()
        })
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
      })
    })

    // TODO(codebytere): remove in Electron v8.0.0
    describe('window.webContents.setFrameRate(frameRate)', () => {
      it('sets custom frame rate', (done) => {
        w.webContents.on('dom-ready', () => {
          w.webContents.setFrameRate(30)
          w.webContents.once('paint', function (event, rect, data) {
            expect(w.webContents.getFrameRate()).to.equal(30)
            done()
          })
        })
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
      })
    })

    describe('window.webContents.FrameRate', () => {
      it('has default frame rate', (done) => {
        w.webContents.once('paint', function (event, rect, data) {
          expect(w.webContents.frameRate).to.equal(60)
          done()
        })
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
      })

      it('sets custom frame rate', (done) => {
        w.webContents.on('dom-ready', () => {
          w.webContents.frameRate = 30
          w.webContents.once('paint', function (event, rect, data) {
            expect(w.webContents.frameRate).to.equal(30)
            done()
          })
        })
        w.loadFile(path.join(fixtures, 'api', 'offscreen-rendering.html'))
      })
    })
  })
})

const expectBoundsEqual = (actual, expected) => {
  if (!isScaleFactorRounding()) {
    expect(expected).to.deep.equal(actual)
  } else if (Array.isArray(actual)) {
    expect(actual[0]).to.be.closeTo(expected[0], 1)
    expect(actual[1]).to.be.closeTo(expected[1], 1)
  } else {
    expect(actual.x).to.be.closeTo(expected.x, 1)
    expect(actual.y).to.be.closeTo(expected.y, 1)
    expect(actual.width).to.be.closeTo(expected.width, 1)
    expect(actual.height).to.be.closeTo(expected.height, 1)
  }
}

// Is the display's scale factor possibly causing rounding of pixel coordinate
// values?
const isScaleFactorRounding = () => {
  const { scaleFactor } = screen.getPrimaryDisplay()
  // Return true if scale factor is non-integer value
  if (Math.round(scaleFactor) !== scaleFactor) return true
  // Return true if scale factor is odd number above 2
  return scaleFactor > 2 && scaleFactor % 2 === 1
}
