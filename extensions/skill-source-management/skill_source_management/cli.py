"""Explicit local CLI. Help/inspection do not initialize or migrate user state."""
import argparse
import json
from pathlib import Path
import sys

from .core import Manager
from .errors import ManagementError
from .packages import inspect_package


def main(argv=None):
    parser = argparse.ArgumentParser(description='Optional local Skill source manager; never runs candidate code')
    parser.add_argument('--home', type=Path, default=Path.home(), help='Existing user Home; use a temporary Home for validation')
    parser.add_argument('--source-root', type=Path, help='Accepted source root inside Home (default .agents/skills)')
    parser.add_argument('--state-root', type=Path, help='Private state root inside Home (default .agents/skill-management)')
    commands = parser.add_subparsers(dest='command')
    inspect = commands.add_parser('inspect', help='Read complete package digest and metadata; no writes')
    inspect.add_argument('--source', required=True, type=Path)
    stage = commands.add_parser('stage', help='Copy a complete local candidate outside discovery; no bootstrap')
    stage.add_argument('--source', required=True, type=Path)
    stage.add_argument('--origin', default='local')
    stage.add_argument('--ref', help='Explicit upstream version/ref evidence; no remote fetch is performed')
    for command in ['install', 'update']:
        action = commands.add_parser(command)
        action.add_argument('--stage', required=True)
        action.add_argument('--expect-source', required=True, help='Digest of the complete reviewed candidate')
        if command == 'update':
            action.add_argument('--expect-current', required=True)
    for command in ['bind', 'unbind']:
        action = commands.add_parser(command)
        action.add_argument('--name', required=True)
        action.add_argument('--client', choices=['codex', 'claude-code'], required=True)
        if command == 'bind':
            action.add_argument('--expect-current', required=True)
    remove = commands.add_parser('uninstall', help='Withdraw owned source after unbinding; retain original in receipt backup')
    remove.add_argument('--name', required=True)
    remove.add_argument('--expect-current', required=True)
    for command in ['verify', 'rollback']:
        action = commands.add_parser(command)
        action.add_argument('--receipt', required=True, type=Path)
    commands.add_parser('audit', help='Check owned sources and views without changing discovery or permissions')
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0
    try:
        if args.command == 'inspect':
            value = inspect_package(args.source)
        else:
            manager = Manager(args.home, args.source_root, args.state_root)
            if args.command == 'stage':
                value = manager.stage(args.source, args.origin, args.ref)
            elif args.command == 'install':
                value = manager.install(args.stage, args.expect_source)
            elif args.command == 'update':
                value = manager.update(args.stage, args.expect_source, args.expect_current)
            elif args.command == 'bind':
                value = manager.bind(args.name, args.client, args.expect_current)
            elif args.command == 'unbind':
                value = manager.unbind(args.name, args.client)
            elif args.command == 'uninstall':
                value = manager.uninstall(args.name, args.expect_current)
            elif args.command == 'verify':
                value = manager.verify(args.receipt)
            elif args.command == 'rollback':
                value = manager.rollback(args.receipt)
            else:
                value = manager.audit()
        print(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2))
        return 0 if value.get('status') not in ['drift', 'interrupted', 'partial'] else 2
    except (ManagementError, OSError, ValueError) as error:
        print(json.dumps({'status': 'refused', 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
