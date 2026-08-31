# add_version_info.tcl
# ---------------------------------------------------------------
# Adds version_info.vhd to the Vivado project, instantiates it in
# a target VHDL file, and appends the BITSTREAM.CONFIG.USR_ACCESS
# property to the XDC constraints file.
#
# Usage (run in Vivado Tcl Console with the project open):
#   source add_version_info.tcl
# Or in batch mode:
#   vivado -mode batch -source add_version_info.tcl -tclargs <path/to/project.xpr>
# ---------------------------------------------------------------

# ---------- 1. Argument / path setup ----------
# In batch mode, open the project passed via command line; otherwise
# use the currently open project.
if {$argc >= 1} {
    set proj_path [lindex $argv 0]
    open_project $proj_path
}

# Resolve real source/constraint directories from files already in the
# project, avoiding a hardcoded dependency on the project name (e.g.
# pcie_system.srcs). This keeps working even if the project is renamed,
# as long as the target files remain in the project.

# Project root directory (where the .xpr lives).
set proj_dir [get_property DIRECTORY [current_project]]

# Derive the sources container name from the .xpr filename instead of
# hardcoding "pcie_system.srcs". Vivado names it "<project_name>.srcs",
# so this stays correct for any project (uart_485_test, pcie_system, ...).
# We glob the .xpr in the project dir rather than guessing a property name.
set xpr_files [glob -nocomplain -directory $proj_dir *.xpr]
if {[llength $xpr_files] > 0} {
    set proj_name [file rootname [file tail [lindex $xpr_files 0]]]
} else {
    set proj_name [current_project]
}
set srcs_dir [file join $proj_dir "${proj_name}.srcs"]

# --- Embedded version_info.vhd template (written verbatim when generated) ---
# Uses a braced string: no Tcl substitution, and the VHDL contains no
# braces, so it is taken literally. Used when the file is not already on
# disk in the target project.
set VERSION_INFO_VHD {library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

library unisim;
use unisim.vcomponents.all;

entity version_info is
  Port (
    compile_version : out std_logic_vector(47 downto 0)
  );
end version_info;

architecture Behavioral of version_info is

  signal DATA             : std_logic_vector(31 downto 0) := (others => '0');
  signal DATAVALID        : std_logic := '0';
  signal CFGCLK           : std_logic;
  signal version_month    : integer range 0 to 12;
  signal version_day      : integer range 0 to 31;
  signal version_hour     : integer range 0 to 23;
  signal version_min      : integer range 0 to 59;
  signal version_year     : integer range 0 to 63;
  signal bcd_month        : std_logic_vector(7 downto 0) := (others => '0');
  signal bcd_day          : std_logic_vector(7 downto 0) := (others => '0');
  signal bcd_hour         : std_logic_vector(7 downto 0) := (others => '0');
  signal bcd_min          : std_logic_vector(7 downto 0) := (others => '0');
  signal bcd_year         : std_logic_vector(7 downto 0) := (others => '0');
  signal version_date_in  : std_logic_vector(31 downto 0) := (others => '0');

begin

  U_USR_ACCESS : USR_ACCESSE2
    port map (
      CFGCLK    => CFGCLK,
      DATA      => DATA,
      DATAVALID => DATAVALID
    );

  -- Extract fields from the USR_ACCESS register and convert to integers
  version_month <= to_integer(unsigned(DATA(26 downto 23)));
  version_day   <= to_integer(unsigned(DATA(31 downto 27)));
  version_hour  <= to_integer(unsigned(DATA(16 downto 12)));
  version_min   <= to_integer(unsigned(DATA(11 downto 6 )));
  version_year  <= to_integer(unsigned(DATA(22 downto 17)));

  -- Convert the extracted integers to BCD
  bcd_month <= std_logic_vector(to_unsigned((version_month / 10)*16 + (version_month mod 10), 8));
  bcd_day   <= std_logic_vector(to_unsigned((version_day   / 10)*16 + (version_day   mod 10), 8));
  bcd_hour  <= std_logic_vector(to_unsigned((version_hour  / 10)*16 + (version_hour  mod 10), 8));
  bcd_min   <= std_logic_vector(to_unsigned((version_min   / 10)*16 + (version_min   mod 10), 8));
  bcd_year  <= std_logic_vector(to_unsigned((version_year / 10)*16 + (version_year mod 10), 8));

  compile_version <= x"20" & bcd_year & bcd_month & bcd_day & bcd_hour & bcd_min;

end Behavioral;
}

# --- Locate or create version_info.vhd ---
set vhd_basename "version_info.vhd"
set vhd_file ""

# 1) Already in the project?
set in_proj [get_files -quiet */$vhd_basename]
if {[llength $in_proj] > 0} {
    set vhd_file [lindex $in_proj 0]
    puts "  \[INFO\] version_info.vhd already in project: $vhd_file"
}

# 2) Physically exists under the project's sources tree?
if {$vhd_file eq ""} {
    foreach sub {sources_1/new sources_1/imports sources_1} {
        set cand [file join $srcs_dir $sub $vhd_basename]
        if {[file exists $cand]} { set vhd_file $cand; break }
    }
}

# 3) Exists next to a sibling VHDL file already in the project?
if {$vhd_file eq ""} {
    set sib [lindex [get_files -quiet -filter {FILE_TYPE == VHDL}] 0]
    if {$sib ne ""} {
        set cand [file join [file dirname $sib] $vhd_basename]
        if {[file exists $cand]} { set vhd_file $cand }
    }
}

# 4) Not found anywhere -> generate it from the embedded template.
if {$vhd_file eq ""} {
    # Prefer a sibling VHDL directory; otherwise the standard sources_1/new.
    set gen_dir ""
    set sib [lindex [get_files -quiet -filter {FILE_TYPE == VHDL}] 0]
    if {$sib ne ""} {
        set gen_dir [file dirname $sib]
    } else {
        set gen_dir [file join $srcs_dir "sources_1" "new"]
    }
    file mkdir $gen_dir
    set vhd_file [file join $gen_dir $vhd_basename]
    set fp [open $vhd_file w]
    puts -nonewline $fp $VERSION_INFO_VHD
    close $fp
    puts "  \[OK\] Generated $vhd_file (from embedded template)"
}

# --- Auto-select the instantiation target file (no fixed filename) ---
# Strategy: scan all VHDL source files and instantiate into the first one
# that declares a compile_version signal. That is the most natural host
# (the module already consumes the compile timestamp). If none is found,
# fall back to the top module file, then leave empty for manual handling.
set target_vhd ""

# 1) Preferred: find a VHDL file that declares compile_version
foreach f [get_files -quiet -filter {FILE_TYPE == VHDL}] {
    set fp [open $f r]
    set fc [read $fp]
    close $fp
    # Match a signal declaration (not a port mapping): a line containing
    # "signal ... : ... compile_version".
    if {[regexp -nocase {signal\s+[^;]*compile_version\s*:} $fc]} {
        set target_vhd $f
        puts "  \[INFO\] Target selected: $f (declares compile_version signal)"
        break
    }
}

# 2) Fallback: use the top module file
if {$target_vhd eq ""} {
    set top_ent [get_property top [current_fileset]]
    if {$top_ent ne ""} {
        foreach f [get_files -quiet -filter {FILE_TYPE == VHDL}] {
            set fp [open $f r]
            set fc [read $fp]
            close $fp
            if {[regexp -nocase "entity\\s+$top_ent\\s+is" $fc]} {
                set target_vhd $f
                puts "  \[INFO\] No compile_version declaration found; using top module file: $f"
                break
            }
        }
    }
}

# 3) If still not found, prompt the user to set the variable manually
if {$target_vhd eq ""} {
    puts "  \[WARN\] Could not auto-locate the instantiation target file."
    puts "         Set it manually and re-run:  set target_vhd <path>; source add_version_info.tcl"
}

# --- Locate the constraints file (derive dir from project name) ---
set xdc_file ""
set anchor_xdc [get_files -quiet */pcie_pin.xdc]
if {[llength $anchor_xdc] > 0} {
    set xdc_file [lindex $anchor_xdc 0]
} else {
    # Fall back to any XDC already in the project.
    set any_xdc [get_files -quiet -filter {FILE_TYPE == XDC}]
    if {[llength $any_xdc] > 0} {
        set xdc_file [lindex $any_xdc 0]
        puts "  \[INFO\] pcie_pin.xdc not found; using: $xdc_file"
    } else {
        # Last resort: standard constraints path derived from the project name.
        set xdc_file [file join $srcs_dir "constrs_2" "new" "pcie_pin.xdc"]
    }
}

set inst_marker    "u_version_info: entity work.version_info"
set xdc_property   "set_property BITSTREAM.CONFIG.USR_ACCESS TIMESTAMP \[current_design\]"

puts "== add_version_info.tcl =="
puts "   vhd_file   : $vhd_file"
puts "   target_vhd : $target_vhd"
puts "   xdc_file   : $xdc_file"

# ---------- 2. Add version_info.vhd to the project (idempotent) ----------
if {[llength [get_files -quiet $vhd_file]] == 0} {
    add_files -norecurse $vhd_file
    puts "  \[OK\] Added $vhd_file"
} else {
    puts "  \[SKIP\] $vhd_file already in project"
}

# ---------- 3. Instantiate version_info in the auto-selected target (idempotent) ----------
if {$target_vhd eq ""} {
    puts "  \[WARN\] No instantiation target specified; skipping instantiation."
    puts "         Set it manually and re-run:  set target_vhd <path>; source add_version_info.tcl"
} elseif {[file exists $target_vhd]} {
    set content [read [open $target_vhd r]]
    if {[string first $inst_marker $content] == -1} {
        # Insert the instantiation before the end of the architecture.
        # Locate the LAST architecture-end statement (case-insensitive) by
        # scanning all matches and keeping the final one. VHDL allows several
        # forms -- "end architecture;", "end architecture <name>;", "end <name>;"
        # (e.g. "end Behavioral;"), and bare "end;". The pattern matches all of
        # them (and also sub-construct ends like "end if;"), but since the
        # architecture body is always the last top-level construct in the file,
        # taking the LAST match reliably yields the architecture end. Only "\s"
        # and "\w" are used (no character classes), which Vivado's regex accepts.
        set eidx  -1
        set epat  {end\s+(architecture\s+)?\w*\s*;}
        set escan 0
        while {[regexp -indices -start $escan -nocase -- $epat $content ematch]} {
            set eidx  [lindex $ematch 0]
            set escan [expr {[lindex $ematch 1] + 1}]
        }
        if {$eidx >= 0} {
            set head [string range $content 0 [expr {$eidx - 1}]]
            set tail [string range $content $eidx end]
            set content "${head}u_version_info: entity work.version_info
    port map (
      compile_version => compile_version
    );
${tail}"
            set fp [open $target_vhd w]
            puts -nonewline $fp $content
            close $fp
            puts "  \[OK\] Instantiated version_info in $target_vhd"
        } else {
            puts "  \[WARN\] Could not locate the end of architecture; skipping instantiation."
        }
    } else {
        puts "  \[SKIP\] $target_vhd already contains version_info instantiation"
    }
} else {
    puts "  \[WARN\] Target file not found: $target_vhd"
}

# ---------- 4. Append USR_ACCESS property to the XDC (idempotent) ----------
if {[file exists $xdc_file]} {
    set xdc [read [open $xdc_file r]]
    if {[string first "USR_ACCESS" $xdc] == -1} {
        set fp [open $xdc_file a]
        puts $fp "\n# --- USR_ACCESS: expose compile timestamp to USR_ACCESSE2 (version_info) ---"
        puts $fp $xdc_property
        close $fp
        puts "  \[OK\] Appended USR_ACCESS property to $xdc_file"
    } else {
        puts "  \[SKIP\] $xdc_file already contains USR_ACCESS property"
    }
} else {
    puts "  \[WARN\] xdc file not found: $xdc_file"
}

puts "== Done =="
