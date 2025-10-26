#!/usr/bin/env python3
"""
SPDX 3.0 SBOM Generator for Archifiltre

Generates Software Bill of Materials in SPDX 3.0 format using the official
Python spdx-tools library. Integrates with security audit results for
enhanced vulnerability tracking.

Usage: python generate-spdx3.py [options]

Author: République française – Ministère de la Culture (SNUM) / CIAF / DINUM
License: CeCILL-2.1
Program: VITAM (Programme interministériel)
"""

import json
import os
import sys
import argparse
import uuid
import glob
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Any
import subprocess

# SPDX 3.0 imports
try:
    from spdx_tools.spdx3.model import (
        SpdxDocument,
        CreationInfo,
        Tool,
        Organization,
        Relationship,
        RelationshipType,
    )
    from spdx_tools.spdx3.model.software import Package, SoftwarePurpose
    # from spdx_tools.spdx3.model.licensing import ListedLicense, NoAssertionLicense
    from spdx_tools.spdx3.model.profile_identifier import ProfileIdentifierType
    from spdx_tools.spdx3.payload import Payload
    from semantic_version import Version
    import yaml
except ImportError as e:
    print(f"Error: SPDX 3.0 tools not available: {e}", file=sys.stderr)
    print("Please install spdx-tools: pip install spdx-tools", file=sys.stderr)
    sys.exit(1)

class SecurityReport:
    """Container for security audit results"""
    def __init__(self):
        self.vulnerabilities = []
        self.findings = []
        self.summary = {
            'total_issues': 0,
            'critical': 0,
            'high': 0,
            'medium': 0,
            'low': 0
        }

class Spdx3Generator:
    """SPDX 3.0 SBOM Generator with Security Integration"""

    def __init__(self, args):
        self.args = args
        self.workspace_dir = Path("/workspace")
        self.output_dir = Path("/output")
        self.security_reports_dir = Path("/security-reports")
        self.base_namespace = "https://archifiltre.fabrique.social.gouv.fr"
        self.payload = Payload()
        self.security_data = SecurityReport()

    def log(self, message: str, level: str = "INFO"):
        """Log message with timestamp and level"""
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        if not self.args.quiet:
            print(f"[{timestamp}] {level}: {message}")

    def load_package_info(self) -> Dict[str, Any]:
        """Load package.json from workspace"""
        package_json_path = self.workspace_dir / "package.json"

        if not package_json_path.exists():
            raise FileNotFoundError(f"package.json not found at {package_json_path}")

        with open(package_json_path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def load_security_reports(self):
        """Load security audit results from reports directory"""
        self.log("Loading security audit results...")

        if not self.security_reports_dir.exists():
            self.log("Security reports directory not found, continuing without security data", "WARN")
            return

        # Look for security audit result files
        report_files = list(self.security_reports_dir.glob("*.json"))

        if not report_files:
            self.log("No security report files found, continuing without security data", "WARN")
            return

        for report_file in report_files:
            try:
                with open(report_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)

                # Parse Trivy results
                if 'trivy' in data and 'vulnerabilities' in data['trivy']:
                    self.security_data.vulnerabilities.extend(data['trivy']['vulnerabilities'])

                # Parse Semgrep results
                if 'semgrep' in data and 'findings' in data['semgrep']:
                    self.security_data.findings.extend(data['semgrep']['findings'])

                # Parse summary
                if 'summary' in data:
                    summary = data['summary']
                    self.security_data.summary['total_issues'] += summary.get('totalIssues', 0)
                    self.security_data.summary['critical'] += summary.get('critical', 0)
                    self.security_data.summary['high'] += summary.get('high', 0)
                    self.security_data.summary['medium'] += summary.get('medium', 0)
                    self.security_data.summary['low'] += summary.get('low', 0)

            except Exception as e:
                self.log(f"Error reading security report {report_file}: {e}", "WARN")

        total_vulns = len(self.security_data.vulnerabilities)
        total_findings = len(self.security_data.findings)
        self.log(f"Loaded {total_vulns} vulnerabilities and {total_findings} security findings")

    def get_git_info(self) -> Dict[str, str]:
        """Get Git repository information"""
        try:
            os.chdir(self.workspace_dir)

            git_sha = subprocess.check_output(
                ['git', 'rev-parse', 'HEAD'],
                stderr=subprocess.DEVNULL,
                text=True
            ).strip()

            git_branch = subprocess.check_output(
                ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                stderr=subprocess.DEVNULL,
                text=True
            ).strip()

            return {'sha': git_sha, 'branch': git_branch}
        except (subprocess.CalledProcessError, FileNotFoundError):
            return {'sha': 'unknown', 'branch': 'unknown'}

    def create_agents(self, package_info: Dict[str, Any]) -> tuple[Tool, Organization]:
        """Create agent elements (Tool and Organization)"""
        tool = Tool(
            spdx_id=f"{self.base_namespace}/spdxdocs/tools/spdx3-generator-v{package_info['version']}",
            name="archifiltre-spdx3-generator",
            creation_info=None
        )

        organization = Organization(
            spdx_id=f"{self.base_namespace}/spdxdocs/agents/republic-french-ministry-culture",
            name="République française – Ministère de la Culture (SNUM) / CIAF / DINUM",
            creation_info=None
        )

        return tool, organization

    def create_creation_info(self, tool: Tool, organization: Organization) -> CreationInfo:
        """Create SPDX 3.0 CreationInfo"""
        timestamp = datetime.now(timezone.utc)

        creation_info = CreationInfo(
            spec_version=Version("3.0.1"),
            created=timestamp,
            created_by=[tool.spdx_id, organization.spdx_id],
            profile=[ProfileIdentifierType.SOFTWARE, ProfileIdentifierType.CORE],
            data_license="CC0-1.0",
            comment="Generated by VITAM program with security vulnerability integration"
        )

        return creation_info

    def create_spdx_document(self, package_info: Dict[str, Any], creation_info: CreationInfo) -> SpdxDocument:
        """Create the main SPDX 3.0 document"""
        document = SpdxDocument(
            spdx_id=f"{self.base_namespace}/spdxdocs/archifiltre-v{package_info['version']}-{uuid.uuid4()}",
            name=f"Archifiltre v{package_info['version']} - SPDX 3.0 SBOM with Security Data",
            creation_info=creation_info,
            element=[],  # Will be populated with references to other elements
            root_element=[]  # Will be set to main package
        )

        return document

    def create_main_package(self, package_info: Dict[str, Any], creation_info: CreationInfo) -> Package:
        """Create the main Archifiltre package element"""
        git_info = self.get_git_info()

        # Enhanced description with security summary
        security_summary = ""
        if self.security_data.summary['total_issues'] > 0:
            security_summary = f" Security: {self.security_data.summary['total_issues']} issues found ({self.security_data.summary['critical']} critical, {self.security_data.summary['high']} high, {self.security_data.summary['medium']} medium, {self.security_data.summary['low']} low)."

        description = f"{package_info.get('description', 'Privacy-friendly desktop archival tool')}.{security_summary}"

        main_package = Package(
            spdx_id=f"{self.base_namespace}/spdxdocs/packages/archifiltre-v{package_info['version']}",
            name=package_info['name'],
            creation_info=creation_info,
            package_version=package_info['version'],
            download_location=package_info.get('repository', {}).get('url', 'https://github.com/ProgrammeVitam/archifiltre'),
            homepage=package_info.get('homepage', 'https://archifiltre.fabrique.social.gouv.fr'),
            copyright_text=f"Copyright République française – Ministère de la Culture (SNUM) / CIAF / DINUM - {datetime.now().year}",
            # declared_license=None,  # TODO: Implement proper SPDX 3.0 license handling
            # concluded_license=None, # TODO: Implement proper SPDX 3.0 license handling
            primary_purpose=SoftwarePurpose.APPLICATION,
            source_info=f"Built from Git commit {git_info['sha']} on branch {git_info['branch']}",
            description=description,
            summary="Desktop archival tool with integrated security scanning"
        )

        return main_package

    def create_dependency_package(self, name: str, version: str, creation_info: CreationInfo) -> Package:
        """Create a dependency package element with security data"""
        # Clean version string
        clean_version = version.replace('^', '').replace('~', '').replace('>=', '').replace('<', '').split(' ')[0]

        # Find vulnerabilities for this package
        package_vulns = [v for v in self.security_data.vulnerabilities if v.get('package') == name]
        vuln_comment = ""
        if package_vulns:
            vuln_count = len(package_vulns)
            high_vuln_count = len([v for v in package_vulns if v.get('severity', '').upper() in ['HIGH', 'CRITICAL']])
            if high_vuln_count > 0:
                vuln_comment = f" WARNING: {vuln_count} vulnerabilities found ({high_vuln_count} high/critical)."
            else:
                vuln_comment = f" {vuln_count} vulnerabilities found."

        # Enhanced license detection could go here
        detected_license = "NOASSERTION"  # Simplified for now

        dep_package = Package(
            spdx_id=f"{self.base_namespace}/spdxdocs/packages/npm-{name}-{clean_version}",
            name=name,
            creation_info=creation_info,
            package_version=clean_version,
            download_location=f"https://registry.npmjs.org/{name}/-/{name}-{clean_version}.tgz",
            # declared_license=None,  # TODO: Implement proper license detection
            # concluded_license=None, # TODO: Implement proper license detection
            copyright_text="NOASSERTION",
            primary_purpose=SoftwarePurpose.LIBRARY,
            comment=f"NPM dependency.{vuln_comment}" if vuln_comment else "NPM dependency"
        )

        return dep_package

    def create_relationships(self, document: SpdxDocument, main_package: Package,
                           dependencies: List[Package], creation_info: CreationInfo) -> List[Relationship]:
        """Create relationships between elements"""
        relationships = []

        # Document describes main package
        doc_describes = Relationship(
            spdx_id=f"{self.base_namespace}/spdxdocs/relationships/doc-describes-{uuid.uuid4()}",
            from_element=document.spdx_id,
            relationship_type=RelationshipType.DESCRIBES,
            to=[main_package.spdx_id],
            creation_info=creation_info
        )
        relationships.append(doc_describes)

        # Main package depends on dependencies
        for dep in dependencies:
            depends_rel = Relationship(
                spdx_id=f"{self.base_namespace}/spdxdocs/relationships/depends-{uuid.uuid4()}",
                from_element=main_package.spdx_id,
                relationship_type=RelationshipType.DEPENDS_ON,
                to=[dep.spdx_id],
                creation_info=creation_info
            )
            relationships.append(depends_rel)

        return relationships

    def generate_payload(self) -> Payload:
        """Generate the complete SPDX 3.0 payload"""
        self.log("Generating SPDX 3.0 payload...")

        # Load data
        package_info = self.load_package_info()
        self.load_security_reports()

        # Create agents
        tool, organization = self.create_agents(package_info)
        self.payload.add_element(tool)
        self.payload.add_element(organization)

        # Create creation info
        creation_info = self.create_creation_info(tool, organization)

        # Create document
        document = self.create_spdx_document(package_info, creation_info)
        self.payload.add_element(document)

        # Create main package
        main_package = self.create_main_package(package_info, creation_info)
        self.payload.add_element(main_package)

        # Set document root element
        document.root_element = [main_package.spdx_id]

        # Create dependency packages
        dependencies = package_info.get('dependencies', {})
        dev_dependencies = package_info.get('devDependencies', {}) if self.args.include_dev_deps else {}

        all_deps = {**dependencies, **dev_dependencies}
        dependency_packages = []

        for name, version in all_deps.items():
            dep_package = self.create_dependency_package(name, version, creation_info)
            self.payload.add_element(dep_package)
            dependency_packages.append(dep_package)

        # Create relationships
        relationships = self.create_relationships(document, main_package, dependency_packages, creation_info)
        for rel in relationships:
            self.payload.add_element(rel)

        # Update document elements list
        document.element = [elem.spdx_id for elem in self.payload.get_full_map().values() if elem != document]

        self.log(f"Created payload with {len(self.payload.get_full_map())} elements:")
        self.log(f"  - 1 SPDX Document")
        self.log(f"  - 1 Main Package")
        self.log(f"  - {len(dependency_packages)} Dependency Packages")
        self.log(f"  - {len(relationships)} Relationships")
        self.log(f"  - 2 Agent Elements (Tool + Organization)")

        return self.payload

    def write_yaml_output(self, payload: Payload, output_path: Path):
        """Write payload to YAML format"""
        self.log(f"Writing YAML output to {output_path}")

        # Find document
        document = None
        for element in payload.get_full_map().values():
            if isinstance(element, SpdxDocument):
                document = element
                break

        # Build YAML structure
        yaml_data = {
            "spdx_version": "3.0.1",
            "data_license": "CC0-1.0",
            "document_namespace": document.spdx_id if document else "unknown",
            "document_name": document.name if document else "Archifiltre SBOM",
            "creation_info": {
                "created": datetime.now(timezone.utc).isoformat(),
                "creators": [
                    "Tool: archifiltre-spdx3-generator",
                    "Organization: République française – Ministère de la Culture (SNUM)"
                ],
                "spec_version": "3.0.1"
            },
            "security_summary": {
                "total_vulnerabilities": len(self.security_data.vulnerabilities),
                "total_findings": len(self.security_data.findings),
                "severity_breakdown": self.security_data.summary
            },
            "elements": {}
        }

        # Add elements
        for spdx_id, element in payload.get_full_map().items():
            element_data = {
                "spdx_id": spdx_id,
                "type": element.__class__.__name__
            }

            # Add common fields
            for field in ['name', 'package_version', 'download_location', 'homepage', 'description', 'comment']:
                if hasattr(element, field) and getattr(element, field):
                    element_data[field] = getattr(element, field)

            # Add license fields
            for field in ['declared_license', 'concluded_license']:
                if hasattr(element, field) and getattr(element, field):
                    element_data[field] = str(getattr(element, field))

            # Add relationship fields
            if hasattr(element, 'relationship_type') and element.relationship_type:
                element_data["relationship_type"] = str(element.relationship_type)
            if hasattr(element, 'from_element') and element.from_element:
                element_data["from_element"] = element.from_element
            if hasattr(element, 'to') and element.to:
                element_data["to"] = element.to

            yaml_data["elements"][spdx_id] = element_data

        # Write file
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write("# SPDX 3.0 Document - Generated by Archifiltre SPDX 3.0 Generator\n")
            f.write(f"# Generated on: {datetime.now(timezone.utc).isoformat()}Z\n")
            f.write("# Organization: République française – Ministère de la Culture (SNUM)\n")
            f.write("# Program: VITAM (Programme interministériel)\n")
            f.write("# Standard: System Package Data Exchange (SPDX) 3.0.1\n")
            f.write("# License: CeCILL-2.1\n")
            f.write("# Security: Integrated vulnerability and security finding data\n\n")
            yaml.dump(yaml_data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    def generate(self):
        """Main generation method"""
        self.log("Archifiltre SPDX 3.0 SBOM Generator")
        self.log("=" * 50)

        try:
            # Generate payload
            payload = self.generate_payload()

            # Ensure output directory exists
            self.output_dir.mkdir(parents=True, exist_ok=True)

            # Load package info for filename
            package_info = self.load_package_info()
            output_filename = f"archifiltre-{package_info['version']}.spdx3.yaml"
            output_path = self.output_dir / output_filename

            # Write output
            self.write_yaml_output(payload, output_path)

            # Summary
            self.log("\nGeneration Summary:")
            self.log(f"  SPDX Version: 3.0.1 (System Package Data Exchange)")
            self.log(f"  Total Elements: {len(payload.get_full_map())}")
            self.log(f"  Output File: {output_path}")
            self.log(f"  Security Data: {len(self.security_data.vulnerabilities)} vulnerabilities, {len(self.security_data.findings)} findings")

            self.log("\nProject Information:")
            self.log("  Standard: SPDX 3.0.1 - System Package Data Exchange")
            self.log("  Organization: République française – Ministère de la Culture (SNUM)")
            self.log("  Program: VITAM (Programme interministériel)")
            self.log("  License: CeCILL-2.1")

            self.log("\nSPDX 3.0 generation completed successfully!")

        except Exception as e:
            self.log(f"Error during generation: {e}", "ERROR")
            if not self.args.quiet:
                import traceback
                traceback.print_exc()
            sys.exit(1)

def parse_args():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="Generate SPDX 3.0 SBOM for Archifiltre with security integration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python generate-spdx3.py                    # Basic generation
  python generate-spdx3.py --exclude-dev-deps # Exclude dev dependencies
  python generate-spdx3.py --quiet           # Quiet mode

SPDX 3.0 SBOM Generator
Organization: République française – Ministère de la Culture (SNUM)
Program: VITAM (Programme interministériel)
License: CeCILL-2.1
        """
    )

    parser.add_argument("--include-dev-deps", action="store_true", default=True,
                       help="Include development dependencies (default)")
    parser.add_argument("--exclude-dev-deps", action="store_false", dest="include_dev_deps",
                       help="Exclude development dependencies")
    parser.add_argument("--quiet", "-q", action="store_true",
                       help="Suppress output messages")
    parser.add_argument("--version", action="version", version="Archifiltre SPDX 3.0 Generator v1.0.0")

    return parser.parse_args()

def main():
    """Main entry point"""
    try:
        args = parse_args()
        generator = Spdx3Generator(args)
        generator.generate()
    except KeyboardInterrupt:
        print("\nOperation cancelled by user.")
        sys.exit(1)
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
