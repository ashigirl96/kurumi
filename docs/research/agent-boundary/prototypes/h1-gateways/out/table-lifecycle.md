| gateway | turn-1 token replayed in turn 2 (then turn 2 own token) | revocation: call→first 401, ms (5 runs) | revoke call itself, ms | stream open at revoke | old container in 4 s after host SIGKILL | after host restart empties registry |
|---|---|---|---|---|---|---|
| ag | 401 Unauthorized / 200 OK | 356.3, 297, 298.7, 358.1, 364 | 67.2, 51.7, 51, 57, 60.5 | 8 chunks after revoke; completed | 200 x15 (container: Up 4 seconds) | 200 x2, 401 x7 |
| mg-host | 401 Unauthorized / 200 OK | 0.3, 0.2, 0.2, 0.1, 0.1 | 0, 0, 0, 0, 0 | 0 chunks after revoke; error: ECONNRESET: The socket connection | ERR TypeError x15 (container: Up 4 seconds) | ERR TypeError x8 |
| mg-ctr | 401 Unauthorized / 200 OK | 0.8, 0.5, 0.7, 0.6, 0.4 | 0.5, 0.4, 0.5, 0.4, 0.4 | 0 chunks after revoke; error: ECONNRESET: The socket connection | 200 x15 (container: Up 4 seconds) | 401 x8 |
