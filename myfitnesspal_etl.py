"""
Personal Data Scientist — MyFitnessPal ETL
==========================================
MyFitnessPal data is imported via CSV export, not web scraping.

The official MFP API is closed to new developers, and the python-myfitnesspal
scraping library no longer supports username/password authentication.

Use these scripts instead:

    Manual import (CSV file):
        python myfitnesspal_import.py path/to/nutrition.csv

    Email automation (checks for MFP export emails):
        python myfitnesspal_email.py --once

    Drop CSV in inbox folder for auto-import:
        Copy CSV to mfp_inbox/ then run myfitnesspal_email.py

See myfitnesspal_import.py and myfitnesspal_email.py for full details.
"""

import sys
print(__doc__)
print("Run: python myfitnesspal_import.py <csv_file>")
sys.exit(0)
