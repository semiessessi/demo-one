/*
  Vendored from the npm package `chiptune3` v0.8.7 (MIT; libopenmpt parts BSD)
  https://github.com/DrSnuggles/chiptune

  ONE local change vs. upstream: the AudioWorklet is loaded from an absolute
  public URL instead of `new URL('./chiptune3.worklet.js', import.meta.url)`.
  Rationale: this module lives in the Vite module graph (src/), but the worklet
  chain (chiptune3.worklet.js -> imports libopenmpt.worklet.js) must be served
  untouched and co-located so the worklet's relative import resolves. Those two
  files live in /public/chiptune/, fetched at runtime by addModule(). See the
  marked line below. (Assumes the app is served at base "/".)
*/

const WORKLET_URL = '/chiptune/chiptune3.worklet.js'; // served from /public/chiptune/

const defaultCfg = {
	repeatCount: -1,		// -1 = play endless, 0 = play once, do not repeat
	stereoSeparation: 100,	// percents
	interpolationFilter: 0,	// https://lib.openmpt.org/doc/group__openmpt__module__render__param.html
	context: false,
}

export class ChiptuneJsPlayer {
	constructor(cfg) {
		this.config = {...defaultCfg, ...cfg}

		if (this.config.context) {
			if (!this.config.context.destination) {
				//console.error('This is not an audio context.')
				throw('ChiptuneJsPlayer: This is not an audio context')
			}
			this.context = this.config.context
			this.destination = false
		} else {
			this.context = new AudioContext()
			this.destination = this.context.destination	// output to speakers
		}
		delete this.config.context	// remove from config, just used here and after init not changeable

		// make gainNode
		this.gain = this.context.createGain()
		this.gain.gain.value = 1

		this.handlers = []

		// worklet  --  LOCAL CHANGE: load from the absolute public URL
		this.context.audioWorklet.addModule( WORKLET_URL )
		.then(()=>{
			this.processNode = new AudioWorkletNode(this.context, 'libopenmpt-processor', {
				numberOfInputs: 0,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			})
			// message port
			this.processNode.port.onmessage = this.handleMessage_.bind(this)
			this.processNode.port.postMessage({cmd:'config', val:this.config})
			this.fireEvent('onInitialized')

			// audio routing
			this.processNode.connect(this.gain)
			if (this.destination) this.gain.connect(this.destination)	// also connect to output if no gainNode was given
		})
		.catch(e=>console.error(e))
	}

	// msg from worklet
	handleMessage_(msg) {
		switch (msg.data.cmd) {
			case 'meta':
				this.meta = msg.data.meta
				this.duration = msg.data.meta.dur
				this.fireEvent('onMetadata', this.meta)
				break
			case 'pos':
				//this.meta.pos = msg.data.pos
				this.currentTime = msg.data.pos
				this.order = msg.data.order
				this.pattern = msg.data.pattern
				this.row = msg.data.row
				this.fireEvent('onProgress', msg.data)
				break
			case 'end':
				this.fireEvent('onEnded')
				break
			case 'err':
				this.fireEvent('onError', {type: msg.data.val})
				break
			case 'fullAudioData':
				this.fireEvent('onFullAudioData', msg.data)
				break
			default:
				console.log('Received unknown message',msg.data)
		}
	}

	// handlers
	fireEvent(eventName, response) {
		const handlers = this.handlers
		if (handlers.length) {
			handlers.forEach(function (handler) {
				if (handler.eventName === eventName) {
					handler.handler(response)
				}
			})
		}
	}
	addHandler(eventName, handler) { this.handlers.push({eventName: eventName, handler: handler}) }
	onInitialized(handler) { this.addHandler('onInitialized', handler) }
	onEnded(handler) { this.addHandler('onEnded', handler) }
	onError(handler) { this.addHandler('onError', handler) }
	onMetadata(handler) { this.addHandler('onMetadata', handler) }
	onProgress(handler) { this.addHandler('onProgress', handler) }
	onFullAudioData(handler) { this.addHandler('onFullAudioData', handler) }

	// methods
	postMsg(cmd, val) {
		if (this.processNode)
			this.processNode.port.postMessage({cmd:cmd,val:val})
	}
	load(url) {
		fetch(url)
		.then(response => response.arrayBuffer())
		.then(arrayBuffer => this.play(arrayBuffer))
		.catch(e=>{this.fireEvent('onError', {type: 'Load'})})
	}
	play(val) { this.postMsg('play', val) }
	stop() { this.postMsg('stop') }
	pause() { this.postMsg('pause') }
	unpause() { this.postMsg('unpause') }
	togglePause() { this.postMsg('togglePause') }
	setRepeatCount(val) { this.postMsg('repeatCount', val) }
	setPitch(val) { this.postMsg('setPitch', val) }
	setTempo(val) { this.postMsg('setTempo', val) }
	setPos(val) { this.postMsg('setPos', val) }
	setOrderRow(o,r) { this.postMsg('setOrderRow', {o:o,r:r}) }
	setVol(val) { this.gain.gain.value = val }
	selectSubsong(val) { this.postMsg('selectSubsong', val) }
	// compatibility
	seek(val) { this.setPos(val) }
	getCurrentTime() { return this.currentTime }
	decodeAll(ab) { this.postMsg('decodeAll', ab) }
}
