module.exports = (RED) => {
  "use strict";

  import("automower-connect").then(
    ({ AutoMowerConnection, AutoConnectWrongCredentialsError, MowerState, MowerActivity, HusqvarnaMowerErrorCode, RestrictedReason }) => {
      // Class
      class AutoMowerNode {
        constructor(config) {
          RED.nodes.createNode(this, config);
          this.mower = config.mower;
          let node = this;

          // Reset status
          const disconnectedState = {
            fill: "grey",
            shape: "ring",
            text: "Not connected",
          };
          node.status(disconnectedState);

          node.connect = async () => {
            try {
              // Connect to mower
              node.mowerConnection = new AutoMowerConnection({
                apiKey: node.credentials.apikey,
                clientSecret: node.credentials.clientsecret,
              });

              // Get mower
              node.autoMower = await node.mowerConnection.getMower(config.mower);

              // Start receiving events
              await node.mowerConnection.activateRealtimeUpdates();

              node.autoMower.on("wsUpdate", (updateList) => {
                let fill = "grey";
                let shape = "dot";
                let text = "";

                // Battery status func
                const batteryStatus = () => {
                  return node.autoMower.batteryPercent > 20
                    ? `🔋${node.autoMower.batteryPercent}%`
                    : `🪫${node.autoMower.batteryPercent}%`;
                };

                // Activity status func
                const activityStatus = () => {
                  switch (node.autoMower.activity) {
                    case MowerActivity.CHARGING:
                      return `Charging | ${batteryStatus()}`;
                    case MowerActivity.GOING_HOME:
                      return `Going Home | ${batteryStatus()}`;
                    case MowerActivity.MOWING:
                      return `Mowing | ${batteryStatus()}`;
                    case MowerActivity.LEAVING:
                      return `Leaving | ${batteryStatus()}`;
                    case MowerActivity.PARKED_IN_CS:
                      return `Parked in CS | ${batteryStatus()}`;
                    case MowerActivity.STOPPED_IN_GARDEN:
                      return `Stoppen in Garden | ${batteryStatus()}`;
                    case MowerActivity.NOT_APPLICABLE:
                      return `Not applicable | ${batteryStatus()}`;
                    case MowerActivity.UNKNOWN:
                      return `Unknown | ${batteryStatus()}`;
                    default:
                      return `${batteryStatus()}`;
                  }
                };

                // Determine status
                switch (node.autoMower.state) {
                  case MowerState.IN_OPERATION:
                  case MowerState.PAUSED:
                  case MowerState.Stopped:
                  case MowerState.NOT_APPLICABLE:
                    fill = "green";
                    text = activityStatus();
                    break;
                  case MowerState.OFF:
                    fill = "yellow";
                    text = "Off";
                    break;
                  case MowerState.UNKNOWN:
                    fill = "yellow";
                    text = "Unknown";
                    break;
                  case MowerState.RESTRICTED:
                    if (node.autoMower.restrictedReason == RestrictedReason.NOT_APPLICABLE) {
                      fill = "green";
                      text = activityStatus();
                    } else {
                      fill = "yellow";
                      text = node.autoMower.restrictedReason ?? "";
                    }
                    break;
                  case MowerState.ERROR:
                  case MowerState.ERROR_AT_POWER_UP:
                  case MowerState.FATAL_ERROR:
                    fill = "red";
                    text = HusqvarnaMowerErrorCode[node.autoMower.errorCode] ?? "";
                    break;
                  default:
                    shape = "ring";
                    break;
                }

                // Set node status
                node.status({
                  fill,
                  shape,
                  text,
                });

                // Send message with updated values
                node.send({
                  mower: {
                    id: node.autoMower.id,
                    name: node.autoMower.data.system.name,
                  },
                  payload: {
                    connected: node.autoMower.isConnected,
                    batteryPercent: node.autoMower.batteryPercent,
                    state: node.autoMower.state,
                    stateTs: node.autoMower.statusTimestamp
                      ? node.autoMower.statusTimestamp.toDate()
                      : undefined,
                    nextStartTs: node.autoMower.nextStartTimestamp
                      ? node.autoMower.nextStartTimestamp.toDate()
                      : undefined,
                    mode: node.autoMower.mode,
                    activity: node.autoMower.activity,
                    errorCode: node.autoMower.errorCode,
                    errorCodeTs: node.autoMower.errorCodeTimestamp
                      ? node.autoMower.errorCodeTimestamp.toDate()
                      : undefined,
                    overrideAction: node.autoMower.overrideAction,
                    restrictedReason: node.autoMower.restrictedReason,
                  },
                  updatesList: updateList,
                });
              });

            } catch (e) {
              // todo: handle
            }
          };

          // On input message received
          node.on("input", async (msg) => {
            try {
              if (node.autoMower) {
                switch (msg.action) {
                  case "pauseMower":
                    await node.autoMower.pauseMower()
                    break;
                  case "parkUntilNextSchedule":
                    await node.autoMower.parkUntilNextSchedule();
                    break;
                  case "parkUntilFurtherNotice":
                    await node.autoMower.parkUntilFurtherNotice();
                    break;
                  case "parkForDurationOfTime":
                    // Parse duration if provided
                    let parkMin = undefined;
                    let parkDuration = parseInt(msg.duration);
                    if (msg.duration && parkDuration) {
                      parkMin = parkDuration;
                    }
                    await node.autoMower.parkForDurationOfTime();
                    break;
                  case "resumeSchedule":
                    await node.autoMower.resumeSchedule();
                    break;
                  case "startMowing":
                    // Parse duration if provided
                    let minutes = undefined;
                    let parsedDuration = parseInt(msg.duration);
                    if (msg.duration && parsedDuration) {
                      minutes = parsedDuration;
                    }

                    // Execute command
                    await node.autoMower.startMowing(minutes);
                    break;
                }
              }
            } catch (e) {
            }
          });



          node.disconnect = async () => {
            try {
              if (node.mowerConnection) {
                await node.mowerConnection.deactivateRealtimeUpdates();
              }
            } catch (e) {
              // todo: handle
            }
          };

          // main
          if (node.credentials.apikey &&
            node.credentials.clientsecret &&
            node.mower) {
            node.connect();
          }

          // close
          node.on("close", async () => {
            await node.disconnect();
          });
        }
      }

      RED.httpAdmin.get(
        "/automower-connection/get-mowers",
        async (req, res) => {
          try {

            if (!req.query.apikey || !req.query.clientsecret) {
              return res.sendStatus(410);
            }

            // Retrieve mower list
            let mowers = [];
            try {
              const automower = new AutoMowerConnection({
                apiKey: req.query.apikey,
                clientSecret: req.query.clientsecret,
              });

              mowers = await automower.getMowers();
            } catch (e) {
              // Wrong credentials?
              while (e.cause) {
                if (e.cause instanceof AutoConnectWrongCredentialsError) {
                  return res.sendStatus(401);
                }
                e = e.cause;
              }
            }

            // Extract id+name of each mower
            const mowerList = [];
            for (const loc of mowers) {
              mowerList.push({
                id: loc.id,
                name: loc.data.system.name,
              });
            }

            // Send
            return res.json(mowerList);
          } catch (e) {
            return res.sendStatus(400);
          }
        }
      );

      RED.nodes.registerType("auto-mower", AutoMowerNode, {
        credentials: {
          apikey: { type: "text" },
          clientsecret: { type: "text" }
        }
      });
    }
  );
};
