/* eslint-disable */
const assert = require('assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const {HL7Message, HL7Server, HL7Client, createServer, connect} = require('../');
const {xVT, VT, FS, xFS, xCR} = require('../lib/types');
const {rejects, doesNotReject} = require('rejected-or-not');

assert.rejects = assert.rejects || rejects;
assert.doesNotReject = assert.doesNotReject || doesNotReject;

const sampleMessage1 = `MSH|^~\\&|LCS|LCA|LIS|TEST9999|19980731153200||ORU^R01|1234|P|2.2
PID|2|2161348462|20809880170|1614614|20809880170^TESTPAT||19760924000000|M|||^^^^00000-0000|||||||86427531^^^03|SSN# HERE
ORC|NW|8642753100012^LIS|20809880170^LCS||||||19980727000000|||HAVILAND
OBR|1|8642753100012^LIS|20809880170^LCS|008342^UPPER RESPIRATORY CULTURE^L|||19980727175800||||||SS#634748641 CH14885 SRC:THROA SRC:PENI|19980727000000||||||20809880170||19980730041800||BN|F
OBX|1|ST|008342^UPPER RESPIRATORY CULTURE^L||FINALREPORT|||||N|F|||19980729160500|BN
ORC|NW|8642753100012^LIS|20809880170^LCS||||||19980727000000|||HAVILAND
OBR|2|8642753100012^LIS|20809880170^LCS|997602^.^L|||19980727175800||||G|||19980727000000||||||20809880170||19980730041800|||F|997602|||008342
OBX|2|CE|997231^RESULT 1^L||M415|||||N|F|||19980729160500|BN
NTE|1|L|MORAXELLA (BRANHAMELLA) CATARRHALIS
NTE|2|L|HEAVY GROWTH
NTE|3|L|BETA LACTAMASE POSITIVE
OBX|3|CE|997232^RESULT 2^L||MR105|||||N|F|||19980729160500|BN
NTE|1|L|ROUTINE RESPIRATORY FLORA
`.replace(/\n/, '\r');
const ack1 = `MSH|^~\\&|LCA|LCS|AcmeHIS|StJohn|19980731153200||ACK^O01|1235|P|2.2
MSA|AA|1234`.replace(/\n/, '\r');

function waitForArrayLength(timeout, length, getLength) {
  const timeoutAt = Date.now() + timeout;

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (getLength() === length) {
        clearInterval(interval);
        return resolve();
      }

      if (Date.now() > timeoutAt) {
        clearInterval(interval);
        return reject(new Error("timeout reached"));
      }
    }, 10);
  })
}

describe('HL7Server', function() {

  let server;
  const tlsoptions = {
    cert: fs.readFileSync(path.resolve(__dirname, './support/public-cert.pem')),
    key: fs.readFileSync(path.resolve(__dirname, './support/private-key.pem')),
    rejectUnauthorized: false,
    port: 8081
  };

  afterEach(function() {
    return server && server.close();
  });

  it('should construct', function() {
    server = new HL7Server();
    assert(server instanceof HL7Server);
    assert.strictEqual(server.listening, false);
    assert.strictEqual(server.sockets.size, 0);
  });

  it('should construct with createServer()', function() {
    server = createServer();
    assert(server instanceof HL7Server);
    assert.strictEqual(server.listening, false);
    assert.strictEqual(server.sockets.size, 0);
  });

  it('should construct with existing server', function() {
    const srv = new net.Server();
    server = new HL7Server(srv);
    assert(server instanceof HL7Server);
    assert.strictEqual(server._server, srv);
  });

  it('should listen than close', function() {
    server = new HL7Server();
    return server.listen(8080).then(() => server.close());
  });

  it('should reject on listen errors', function() {
    server = new HL7Server();
    return assert.rejects(() =>
        server.listen(8080)
            .then(() => server.listen())
    );
  });

  it('should emit "connection" event', function(done) {
    server = createServer(() => {
      server.close().then(() => done());
    });
    server.listen(8080)
        .then(() => connect(8080));
  });

  it('should add middle-wares', function() {
    server = new HL7Server();
    server.use(() => {});
  });

  it('should emit valid hl7 payloads', function(done) {
    server = new HL7Server();

    server.listen(8080).then(() => {
      const payloads = [];
      server.on('payload', (payload) => payloads.push(payload.toString("utf-8")));

      const msg = HL7Message.parse(sampleMessage1);

      let handlerCallCount = 0;
      server.use((req) => {
        handlerCallCount += 1;

        try {
          assert.strictEqual(req.toHL7(), msg.toHL7());
        } catch (e) {
          done(e);
        }
      });

      const client = new HL7Client();

      return client
        .connect(8080)
        .then(() => client.sendReceive(msg))
        .then(() => client.close())
        .then(() => server.close())
        .then(() => waitForArrayLength(1000, 1, () => payloads.length))
        .then(() => {
          try {
            assert.strictEqual(handlerCallCount, 1);
            assert.equal(payloads[0].length > 0, true);

            done()
          } catch (e) {
            done(e)
          }
        });
    }).catch((e) => done(e));
  });

  it('should emit invalid payloads', function(done) {
    server = new HL7Server();

    server.listen(8080).then(() => {
      const payloads = [];
      server.on('payload', (payload) => payloads.push(payload.toString('utf-8')));

      let handlerCallCount = 0;
      server.use((_) => {
        handlerCallCount += 1;
      });

      const client = new HL7Client();

      client.sendHl7Message = (str) => {
        return new Promise((resolve) => {
          const _buf = Buffer.from([xVT, ...iconv.encode(str, 'utf8'), xFS, xCR]);

          client._socket.write(_buf, null, () => {
            // this will not close the socket but just "end" sending data
            client._socket.end(() => {
              resolve();
            });
          });
        });
      };

      // construct an invalid HL7 message
      let msg = HL7Message.parse(sampleMessage1).toHL7();
      const lines = msg.split('\r');
      lines[1] = ['UNKNOWN', ...lines[1].split('|').slice(1)].join("|")
      msg = lines.join('\r')

      return client
        .connect(8080)
        .then(() => client.sendHl7Message(msg))
        .then(() => client.close())
        .then(() => server.close())
        .then(() => waitForArrayLength(1000, 1, () => payloads.length))
        .then(() => {
          try {
            assert.strictEqual(handlerCallCount, 0);
            assert.equal(payloads[0].length > 0, true);

            done()
          } catch (e) {
            done(e)
          }
        });
    }).catch((e) => done(e));
  });

  it('should receive hl7 messages', function(done) {
    server = new HL7Server();
    server.listen(8080).then(() => {
      const msg = HL7Message.parse(sampleMessage1);
      let i = 0;

      server.use('ORU^R01', (req) => {
        i++;
        try {
          assert.strictEqual(req.toHL7(), msg.toHL7());
        } catch (e) {
          done(e);
        }
      });

      server.use((req) => {
        i++;
        try {
          assert.strictEqual(i, 2);
          assert.strictEqual(req.toHL7(), msg.toHL7());
          server.close().then(() => done());
        } catch (e) {
          done(e);
        }
      });

      const client = new HL7Client();
      client.connect(8080).then(() => {
        client.send(msg);
      });
    }).catch((e) => done(e));
  });

  it('should receive hl7 messages - tsl', function(done) {
    server = new HL7Server(tlsoptions);
    server.listen(tlsoptions).then(() => {
      const msg = HL7Message.parse(sampleMessage1);
      let i = 0;

      server.use('ORU^R01', (req) => {
        i++;
        try {
          assert.strictEqual(req.toHL7(), msg.toHL7());
        } catch (e) {
          done(e);
        }
      });

      server.use((req) => {
        i++;
        try {
          assert.strictEqual(i, 2);
          assert.strictEqual(req.toHL7(), msg.toHL7());
          server.close().then(() => done());
        } catch (e) {
          done(e);
        }
      });

      const client = new HL7Client();
      client.connect(tlsoptions).then(() => client.send(msg));
    }).catch((e) => done(e));
  });

  it('should receive hl7 messages and send response', function(done) {
    server = new HL7Server();
    server.listen(8080).then(() => {
      const msg = HL7Message.parse(sampleMessage1);
      const ack = HL7Message.parse(ack1);
      server.use(() => ack);

      const client = new HL7Client();
      client.connect(8080).then(() => {
        client.sendReceive(msg).then(resp => {
          try {
            assert.strictEqual(ack.toHL7(), resp.toHL7());
            server.close().then(() => done());
          } catch (e) {
            done(e);
          }
        });
      });
    }).catch((e) => done(e));
  });

  it('should receive hl7 messages and send response with Latin 1 encoding', function(done) {
    const encoding = 'latin1';

    const sampleLatin1Message1 = sampleMessage1.replace('TESTPAT', 'Scandinavian patient åäöÅÄÖæøÆØ');
    const latin1Ack1 = ack1.replace('StJohn', 'Scandinavian hospital åäöÅÄÖæøÆØ');

    server = new HL7Server({ encoding });

    // Simulate client using Latin 1 encoding
    const client = new HL7Client();
    client.setEncoding(encoding);

    server.listen(8080).then(() => {
      const msg = HL7Message.parse(sampleLatin1Message1);
      const ack = HL7Message.parse(latin1Ack1);

      server.use((req) => {
        try {
          assert.strictEqual(req.getSegment('PID').PatientName[0].GivenName.value, 'Scandinavian patient åäöÅÄÖæøÆØ');
          return ack;
        } catch (e) {
          done(e);
        }
      });

      client.connect(8080).then(() => {
        client.sendReceive(msg).then(res => {
          try {
            assert.strictEqual(ack.toHL7(), res.toHL7());
            assert.strictEqual(res.MSH.ReceivingFacility.value, 'Scandinavian hospital åäöÅÄÖæøÆØ');
            server.close().then(() => done());
          } catch (e) {
            done(e);
          }
        });
      });
    }).catch((e) => done(e));
  });

  it('should send nak if no middle-ware matches', function(done) {
    server = new HL7Server();
    server.listen(8080).then(() => {
      const msg = HL7Message.parse(sampleMessage1);
      server.use('ORU^R02', () => {});
      const client = new HL7Client();
      client.connect(8080).then(() => {
        client.sendReceive(msg).then(msg => {
          assert(msg);
          assert.strictEqual(msg.MSH.MessageType.value, 'ACK');
          const msa = msg.getSegment('MSA');
          assert.strictEqual(msa[1].value, 'AR');
          server.close().then(() => done());
        });
      });
    }).catch((e) => done(e));
  });

  it('should not exceed max buffer size', function(done) {
    server = new HL7Server({
      maxBufferPerSocket: 32
    });

    server.on('error', e => {
      if (e.message.includes('exceeded'))
        return server.close().then(() => done());
      done(e);
    });

    server.listen(8080).then(() => {
      const client = new HL7Client();
      client.connect(8080).then(() => {
        client.send(sampleMessage1);
      });
    }).catch((e) => done(e));
  });

  it('should close socket if error count >= maxErrorsPerSocket', function(done) {
    server = new HL7Server();
    const client = new HL7Client();

    client.on('close', () => {
      return server.close().then(() => done());
    });

    server.listen(8080).then(() => {
      client.connect(8080).then(() => {
        const send = () => {
          client._socket.write(VT + 'INVALID' + FS);
          client._socket.write(VT + 'INVALID' + FS);
          client._socket.write(VT + 'INVALID' + FS);
          client._socket.write(VT + 'INVALID' + FS);
          client._socket.write(VT + 'INVALID' + FS);
        };
        send();
      });
    }).catch((e) => done(e));
  });

  it('should handle unknown segments gracefully', function(done) {
    server = new HL7Server();
    const client = new HL7Client();

    let receivedParseErrorCount = 0;

    client.sendRaw = (str) => {
      return new Promise((resolve) => {
        const buf = Buffer.from([xVT, ...iconv.encode(str, client.encoding || 'utf-8'), xFS, xCR]);

        client._socket.write(buf, null, () => {
          client._socket.end(() => resolve());
        });
      });
    };

    client.on('close', () => {
      server.close().then(() => {
        done(
          receivedParseErrorCount === 1
            ? undefined
            : new Error("Did not receive parse error before closing")
        );
      });
    });

    server.on('error', (error) => {
      if (error.message.includes('Invalid HL7 data received from')) {
        receivedParseErrorCount += 1;
        if (receivedParseErrorCount === 1) error.socket.destroy();
      }
    });

    server.use(() => {
      done(new Error("Server handler should not have been called"));
    });

    // construct the HL7 message with an unknown segment
    let msg = HL7Message.parse(sampleMessage1).toHL7();

    const lines = msg.split('\r');
    lines[1] = ['UNKNOWN_AF73ASD', ...lines[1].split('|').slice(1)].join("|")

    msg = lines.join('\r')

    server
      .listen(8080)
      .then(() => client.connect(8080))
      .then(() => client.sendRaw(msg))
      .then(() => client.close())
      .catch((e) => done(e));
  });

  it('should send nak if error in middle-wares', function(done) {
    server = new HL7Server();
    const client = new HL7Client();

    server.use(() => {
      throw new Error('Any error');
    });

    server.listen(8080).then(() => {
      client.connect(8080).then(() => {
        client.sendReceive(sampleMessage1).then(msg => {
          assert(msg);
          assert(msg.MSH);
          assert(msg.getSegment('ERR'));
          server.close().then(() => done());
        });
      });
    }).catch((e) => done(e));
  });

  it('should send nak if rejected in middle-wares', function(done) {
    server = new HL7Server();
    const client = new HL7Client();

    server.use(() => {
      return Promise.reject(new Error('Any error'));
    });

    server.listen(8080).then(() => {
      client.connect(8080).then(() => {
        client.sendReceive(sampleMessage1).then(msg => {
          assert(msg);
          assert(msg.MSH);
          assert(msg.getSegment('ERR'));
          server.close().then(() => done());
        });
      });
    }).catch((e) => done(e));
  });

  it('should wait connections for shutdownWait time', function(done) {
    this.slow(250);
    const client = new HL7Client();
    server = createServer({shutdownWait: 100});
    server.use(() => {
      const t1 = Date.now();
      server.close().then(() => {
        try {
          assert(Date.now() - t1 > 100, 'Failed');
          done();
        } catch (e) {
          done(e);
        }
      });
    });

    server.use(() => {
      return new Promise((() => {
        // Never resolve
      }));
    });
    server.listen(8080).then(() => {
      client.connect(8080).then(() => client.send(sampleMessage1));
    }).catch(e => done(e));
  });

  it('should close before shutdownWait time if there is no message to response', function(done) {
    this.slow(500);
    const client = new HL7Client();
    server = createServer({shutdownWait: 5000});
    server.use(() => {
      const t1 = Date.now();
      server.close().then(() => {
        try {
          const n = Date.now() - t1;
          assert(n > 50, 'Failed ' + n + '>50');
          assert(n < 100, 'Failed ' + n + '<100');
          done();
        } catch (e) {
          done(e);
        }
      });
    });

    server.use(() => {
      return new Promise((resolve => {
        setTimeout(() => {resolve();}, 50);
      }));
    });
    server.listen(8080).then(() => {
      client.connect(8080).then(() => client.send(sampleMessage1));
    }).catch(e => done(e));
  });

  it('should emit "listenError"', function(done) {
    server = createServer();
    server.listen(8080)
        .then(() => {
          const server2 = createServer();
          server2.on('error', (e) => {
            if (e.syscall !== 'listen')
              return done(e);
            server.close().then(() => done());
          });
          server2.listen(8080).catch(() => {});
        });
  });

  it('should parse custom segments', function(done) {
    const customDict = {
      segments: {
        ZDS: {
          desc: '',
          fields: [
            {
              dt: 'RP',
              desc: 'Study Instance UID',
              opt: 'R',
              rep: 1
            },
            {
              dt: 'ST',
              desc: 'pointer',
              opt: 'R',
              rep: 1
            }
          ]
        }
      },
      fields: {
        RP: {
          desc: "Reference Pointer",
          components: [
            {
              dt: 'ST',
              desc: 'pointer',
              opt: 'O',
              rep: 1
            }
          ]
        }
      }
    };

    const messageString = sampleMessage1 + '\rZDS|1.2.345.67.8.9.12341234123412.345|1.2.345.67.8.9.12341234123412.345';

    server = new HL7Server({customDict});
    server.listen(8080).then(() => {
      const msg = HL7Message.parse(messageString, { customDict });
      let i = 0;

      server.use('ORU^R01', (req) => {
        i++;
        try {
          assert.strictEqual(req.toHL7(), msg.toHL7());
        } catch (e) {
          done(e);
        }
      });

      server.use((req) => {
        i++;
        try {
          assert.strictEqual(i, 2);
          assert.strictEqual(req.toHL7(), msg.toHL7());
          server.close().then(() => done());
        } catch (e) {
          done(e);
        }
      });

      const client = new HL7Client({customDict});
      client.connect(8080).then(() => {
        client.send(msg);
      });
    }).catch((e) => done(e));
  })
});
