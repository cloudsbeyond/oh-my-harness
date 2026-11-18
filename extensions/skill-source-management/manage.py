#!/usr/bin/env python3
"""Run from a checkout without installing an agent Skill or Python package."""
import sys
sys.dont_write_bytecode = True
from skill_source_management.cli import main

if __name__ == '__main__':
    sys.exit(main())
