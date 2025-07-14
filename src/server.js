const WebSocket = require('ws');
const fs = require('node:fs');

const Client = require('./Client');
const RoomList = require('./RoomList');
const Room = require('./Room');
const ConnectionError = require('./ConnectionError');
const ConnectionManager = require('./ConnectionManager');
const validators = require('./validators');
const logger = require('./logger');
const naughty = require('./naughty');
const config = require('./config');


const wss = new WebSocket.Server({
  noServer: true, // we setup the server on our own
  clientTracking: false, // we do our own tracking
  maxPayload: 1024 * 1024 * 1024, // 1 MB should be plenty
  perMessageDeflate: config.perMessageDeflate,
});

const rooms = new RoomList();
rooms.enableLogging = true;
//rooms.startJanitor();

const connectionManager = new ConnectionManager();
connectionManager.start();

logger.info(`Naughty word detector has ${naughty.getTotalBlockedPhrases()} blocked phrases from ${naughty.getTotalFilterLists()} filters`);

/**
 * @param {unknown} data
 * @returns {boolean}
 */
function isValidMessage(data) {
  // @ts-ignore
  return !!data && typeof data === 'object' && typeof data.method === 'string';
}

/**
 * Parse WebSocket message data.
 * @param {string} data Message data
 * @returns {object}
 */
function parseMessage(data) {
  const message = JSON.parse(data);
  if (!isValidMessage(message)) {
    throw new Error('Invalid message');
  }
  return message;
}

/**
 * Create a "set" message to send to clients to set a variable.
 * @param {string} name The name of the variable.
 * @param {string|number} value The variable's new value.
 * @returns {string} The stringified JSON of the message.
 */
function createSetMessage(name, value) {
  return JSON.stringify({
    method: 'set',
    name: name,
    value: value,
  });
}

const buffered = new Map();
function sendBuffered() {
  if (buffered.size > 0) {
    for (const [client, messages] of buffered.entries()) {
      client.send(messages.join('\n'));
    }
    buffered.clear();
  }
}

function sendToClient(client, message) {
  if (config.bufferSends) {
    if (buffered.has(client)) {
      buffered.get(client).push(message);
    } else {
      buffered.set(client, [message]);
    }
  } else {
    client.send(message);
  }
}

if (config.bufferSends) {
  setInterval(sendBuffered, 1000 / config.bufferSends);
}

wss.on('connection', (ws, req) => {
  // We know of at least one library that sends Scratch session tokens to us for no reason.
  // As this is putting accounts at unnecessary risk, refuse to accept the connection until they fix their code.
  // It's not important for us to really parse cookies, we just want it to be hard to do the wrong thing.
  if (req.headers.cookie && req.headers.cookie.startsWith('scratchsessionsid=')) {
    logger.info('A connection closed for security reasons.');
    // Sending an invalid message to the client should hopefully trigger a warning somewhere for them to see.
    ws.send('The cloud data library you are using is putting your Scratch account at risk by sending us your login token for no reason. Change your Scratch password immediately, then contact the maintainers of that library for further information. This connection is being refused to protect your security.');
    ws.close(4005);
    return;
  }

  const client = new Client(ws, req);

  connectionManager.handleConnect(client);

    function performHandshake(roomId, username) {
        if (client.room) throw new ConnectionError(ConnectionError.Error, 'Already performed handshake');
        if (!validators.isValidRoomID(roomId)) {
            throw new ConnectionError(ConnectionError.Error, `Invalid room ID: ${roomId}`);
        }
        if (!validators.isValidUsername(username)) {
            throw new ConnectionError(ConnectionError.Username, `Invalid username: ${username}`);
        }

        client.setUsername(username);

        const path = `/home/wally/cloud-server/save/${roomId}`;
        let room;
        if (rooms.has(roomId)) {
            room = rooms.get(roomId);
        } else {
            room = rooms.create(roomId);

            // Load saved data if the file exists
            if (fs.existsSync(path)) {
                try {
                    const savedData = JSON.parse(fs.readFileSync(path, 'utf8'));
                    
                    // Ensure variables are created before setting values
                    Object.entries(savedData).forEach(([name, value]) => {
                        if (!room.has(name)) {
                            room.create(name, value); // Use create() instead of set()
                        } else {
                            room.set(name, value);
                        }
                    });

                    console.log(`✅ Loaded saved variables for room ${roomId}`);
                } catch (err) {
                    console.error(`❌ Error loading room data for ${roomId}:`, err);
                }
            }
        }

        client.setRoom(room);

        // Send all variables to the client on join
        const messages = [];
        room.getAllVariables().forEach((value, name) => {
            messages.push(createSetMessage(name, value));
        });

        if (messages.length > 0) {
            client.send(messages.join('\n'));
        }

        client.log(`Joined room (peers: ${client.room.getClients().length})`);
    }




  function performCreate(variable, value) {
    performSet(variable, value);
  }

  function performDelete(variable) {
    if (!config.enableDelete) {
      return;
    }

    if (!client.room) throw new ConnectionError(ConnectionError.Error, 'No room setup yet');

    client.room.delete(variable);
  }

  function performRename(oldName, newName) {
    if (!config.enableRename) {
      return;
    }

    if (!client.room) throw new ConnectionError(ConnectionError.Error, 'No room setup yet');

    if (!validators.isValidVariableName(newName)) {
      throw new Error(`Invalid variable name: ${newName}`);
    }

    // get throws if old name does not exist
    const value = client.room.get(oldName);
    client.room.delete(oldName);
    client.room.set(newName, value);
  }

    function performSet(variable, value) {
        if (!client.room) throw new ConnectionError(ConnectionError.Error, 'No room setup yet');
    
        if (!validators.isValidVariableValue(value)) {
            logger.debug('Ignoring invalid value: ' + value);
            return;
        }

        if (client.room.has(variable)) {
            client.room.set(variable, value);
        } else {
            client.room.create(variable, value);
        }
    
        // Save to file AFTER setting variable
        const path = "/home/wally/cloud-server/save/" +     client.room.id;
    
        if (fs.existsSync(path)) {
            fs.writeFile(path, JSON.stringify(Object.fromEntries(client.room.getAllVariables()), null, 2), err => {
                if (err) {
                    console.error("File write error:", err);
                }
            });
        }

    
        // Broadcast update to clients
        const clients = client.room.getClients();
        if (clients.length > 1) {
            const message = createSetMessage(variable, value);
            for (const otherClient of clients) {
                if (client !== otherClient) {
                    sendToClient(otherClient, message);
                }
            }
        }
    }


  function processMessage(data) {
    const message = parseMessage(data.toString());
    const method = message.method;

    switch (method) {
      case 'handshake':
        performHandshake('' + message.project_id, message.user);
        break;

      case 'set':
        performSet(message.name, message.value);
        break;

      case 'create':
        performCreate(message.name, message.value);
        break;

      case 'delete':
        performDelete(message.name);
        break;

      case 'rename':
        performRename(message.name, message.new_name);
        break;

      default:
        throw new ConnectionError(ConnectionError.Error, 'Unknown message method: ' + method);
    }
  }

  client.log('Connection opened');

  ws.on('message', (data, isBinary) => {
    // Ignore data after the socket is closed
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    if (isBinary) {
      return;
    }

    try {
      processMessage(data);
    } catch (error) {
      client.error('Error handling connection: ' + error);
      if (error instanceof ConnectionError) {
        client.close(error.code);
      } else {
        client.close(ConnectionError.Error);
      }
    }
  });

  ws.on('error', (error) => {
    client.error('** ERROR ** ' + error);
    client.close(ConnectionError.Error);
  });

  ws.on('close', (code) => {
    connectionManager.handleDisconnect(client);
    client.log(`Connection closed: code ${code}`);
    client.close(ConnectionError.Error);
  });

  ws.on('pong', () => {
    connectionManager.handlePong(client);
  });
});

wss.on('close', () => {
  logger.info('WebSocket server closing');
  connectionManager.stop();
  rooms.destroy();
});

module.exports = wss;
