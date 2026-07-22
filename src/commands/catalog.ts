import { printValue } from "../format.ts";
import { findGate, listGates } from "../gates.ts";
import { findLoop, listLoops } from "../loops.ts";
import { canonicalAgentId, listAgentRoles } from "../roles.ts";
import { type ParsedArgs, outputFormat, requiredArg } from "./shared.ts";

export function handleAgent(action: string | undefined, args: string[], parsed: ParsedArgs): void {
  if (action === "list") {
    printValue(listAgentRoles().map((role) => ({
      id: role.id,
      name: role.name,
      accepts: role.accepts.join(","),
      skills: role.skills.join(","),
      gates: role.gates.join(","),
      maxSideEffect: role.maxSideEffect,
    })), outputFormat(parsed));
    return;
  }
  if (action === "show") {
    const roleId = requiredArg(args, 0, "agent role id");
    const role = listAgentRoles().find((item) => item.id === canonicalAgentId(roleId));
    if (!role) throw new Error(`Agent role not found: ${roleId}`);
    printValue(role, outputFormat(parsed));
    return;
  }
  throw new Error(`Unknown agent action: ${action ?? ""}`);
}

export function handleGate(action: string | undefined, args: string[], parsed: ParsedArgs): void {
  if (action === "list") {
    printValue(listGates(), outputFormat(parsed));
    return;
  }
  if (action === "show") {
    const gateId = requiredArg(args, 0, "gate id");
    const gate = findGate(gateId);
    if (!gate) throw new Error(`Gate not found: ${gateId}`);
    printValue(gate, outputFormat(parsed));
    return;
  }
  throw new Error(`Unknown gate action: ${action ?? ""}`);
}

export function handleLoop(action: string | undefined, args: string[], parsed: ParsedArgs): void {
  if (action === "list") {
    printValue(listLoops().map((loop) => ({
      id: loop.id,
      name: loop.name,
      ownerRole: loop.ownerRole,
      participants: loop.participants.join(","),
      gates: loop.gates.join(","),
      requiredInputs: loop.inputs.filter((input) => input.required).map((input) => input.key).join(","),
      requiredOutputs: loop.outputs.filter((output) => output.required).map((output) => output.key).join(","),
      implementation: loop.implementation,
    })), outputFormat(parsed));
    return;
  }
  if (action === "show") {
    const loop = findLoop(requiredArg(args, 0, "loop id"));
    if (!loop) throw new Error(`Loop not found: ${args[0]}`);
    printValue(loop, outputFormat(parsed));
    return;
  }
  throw new Error(`Unknown loop action: ${action ?? ""}`);
}
